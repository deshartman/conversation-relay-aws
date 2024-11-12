/**
 *  app.js -- default Handler
 * 
 * Handles inbound websocket messages from ConversationRelay server
 * and handles tool completion events passed in from SNS.
 * 
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddbDocClient = DynamoDBDocumentClient.from(client);       

import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";

// Code for this lambda broken into several modules 
import { handlePrompt } from './handle-prompt.mjs';
import { invokeStateMachine } from './invoke-state-machine.mjs';
import { returnAllChats, savePrompt} from './database-helpers.mjs';
import { replyToWS } from './reply-to-ws.mjs';

export const lambdaHandler = async (event, context) => {    

    console.info("EVENT\n" + JSON.stringify(event, null, 2));    

    let body = null;
    let connectionId = null; 
    let ws_domain_name = null;
    let ws_stage = null;
    let toolCallCompletion = false;

    // Check if this is a tool call completion event
    if (event?.Records && event.Records[0]?.EventSource === "aws:sns") {
        
        let snsBody = JSON.parse(event?.Records[0]?.Sns.Message);
        connectionId = snsBody[0].ws_connectionId;
        ws_domain_name = snsBody[0].ws_domain_name;
        ws_stage = snsBody[0].ws_stage;
        toolCallCompletion = true;

    } else {
        // This is an event generated by the WebSocket connection
        connectionId = event.requestContext.connectionId;
        ws_domain_name = event.requestContext.domainName;
        ws_stage = event.requestContext.stage;
        body = JSON.parse(event.body);
    }

    // Get the core details from this connection (included user context,
    // use case, configuration details)
    const callConnection = await ddbDocClient.send( new GetCommand( { TableName: process.env.TABLE_NAME, Key: { pk: connectionId, sk: "connection" } } ));
   
    try {

        // Instantiate WebSocket client to return text to Twilio
        // This client can be used in this lambda and/or passed
        // to other modules.
        const ws_client = new ApiGatewayManagementApiClient( {
            endpoint: `https://${ws_domain_name}/${ws_stage}`
        });

        // Text prompts and dtmf events sent via WebSockets 
        // and tool call completion events follow the same steps and call the LLM
        if (body?.type === "prompt" || body?.type === "dtmf" || toolCallCompletion) {
            
            /**
             * SEQUENCE SUMMARY
             * 1) Get chat history
             * 2) Persist current prompt (if not tool call completion)
             * 3) Call LLM
             * 4) Handle response from LLM
             */
            
            // Get all chat messages for this session 
            // All messages saved with connectionId as primary key
            // and string with timestamp for simple query that
            // returns chronologically sorted results.
            // This is the chat history between system, assistant, tools, user
            const messages = await returnAllChats(ddbDocClient, connectionId);    

            // Set the tool choice to auto which lets the LLM decide
            // whether or not to call a tool. This can be changed if
            // an event requires calling a tool.
            let tool_choice = "auto";

            // If this is a prompt from the WebSocket connection, then it
            // is text (speech-to-text) from the user. Persist the user prompt 
            // to the database and include it in chat messages before calling LLM.
            if (body?.type === "prompt") { // VOICE PROMPT EVENT
                
                // Format the prompt from the user to LLM standards.
                let newUserChatMessage = { role: "user", content: body.voicePrompt };
                
                // Persist the current prompt so it is included in subsequent calls.
                await savePrompt(ddbDocClient, connectionId, newUserChatMessage);                

                // Add message to context before calling LLM in this current event.
                messages.push( newUserChatMessage );
            
            } else if (body?.type === "dtmf") { // DTMF EVENT               
                // "dtmf" event is from the WebSocket server, then the
                // user has pushed a phone button. Build a prompt for this case.

                /**
                 * {
                 *  'type': 'dtmf',
                 *  'digit': '1'
                 * }
                 */
                
                // dtmf handlers are included in the use case configuration and
                // attached to a session. The dtmf handlers can be overwritten
                // if need as a user moves through a session.
                let dtmfHandlers = JSON.parse(callConnection.Item.dtmfHandlers);                
                //console.info("==> dtmfHandlers\n" + JSON.stringify(dtmfHandlers, null, 2));   
                
                // Pull the response associated to the digit pressed
                let dtmfResponse = dtmfHandlers[body.digit];
                //console.info("==> dtmfResponse\n" + JSON.stringify(dtmfResponse, null, 2));                

                if (!dtmfResponse) {
                    
                    console.log("Could not find DTMF handler for current use case / digit.");
                    throw new Error('Could not find DTMF handler for current use case / digit.');

                } else {

                    // Format the dtmf event from the user into to LLM standards.
                    let newUserDTMFMessage = { 
                        role: "system", 
                        content: `The user pushed the ${body?.digit} keypad button.` 
                    };

                    if (dtmfResponse.replyWithText) {
                        newUserDTMFMessage.content = newUserDTMFMessage.content + ` Reply to the user with this text: "${dtmfResponse.replyText}"`; 
                        
                        // If a tool call is required, then the reply text needs
                        // to sent here because the LLM will not return the text
                        // because it is will be told to only return the tool call (function)
                        if (dtmfResponse.replyWithFunction) {
                            // Since we are forcing a tool call, force the text reply now                            
                            await replyToWS(ws_client, connectionId, {   
                                type:"text",
                                token: dtmfResponse.replyText, 
                                last: true
                            });                            
                        }
                    }

                    // If the dtmf tiggers a tool call, then adjust the prompt to llm accordingly.
                    if (dtmfResponse.replyWithFunction) {
                        // set object for tool choice
                        tool_choice = { "type": "function", "function": {"name":dtmfResponse.replyFunction }};
                        newUserDTMFMessage.content = newUserDTMFMessage.content + " Call the tool and wait.";                                                                       
                    }                    
                    
                    // Persist the current prompt so it is included in subsequent calls.
                    await savePrompt(ddbDocClient, connectionId, newUserDTMFMessage);
     
                    // Add message to context before calling LLM in this current event.
                    messages.push( newUserDTMFMessage );

                }


            } else if (toolCallCompletion) { // TOOL CALL COMPLETION EVENT

                /**
                 * Upon completing one or more tool calls, this function is
                 * invoked to continue the conversation. The tool call lambdas update
                 * the database with their results so they would already be 
                 * in the "messages" array. 
                 * 
                 * The boolean toolCallCompletion is passed to the LLM handler
                 * and the call to the LLM can be adjusted if needed.
                 * 
                 * No additional processing needed for current implementation, but if
                 * needed, it could be done here.
                 */

            }

            console.info("messages before calling LLM\n" + JSON.stringify(messages, null, 2));   

            // Call the LLM passing context and chat history
            let llmResult = await handlePrompt({
                ws_endpoint: `${ws_domain_name}/${ws_stage}`,
                ws_connectionId: connectionId, 
                messages: messages,
                callConnection: callConnection.Item,
                toolCallCompletion: toolCallCompletion,
                tool_choice: tool_choice,
                ws_client:ws_client
            });

            console.info("llmResult\n" + JSON.stringify(llmResult, null, 2));

            // Format the llmResult into a chat message to persist to the database
            let newAssistantChatMessage = {
                role: "assistant",
                content: llmResult.content,
                refusal: llmResult.refusal
            };
            
            // If tool_calls are present, convert the tool call object to
            // an array to adhere to llm chat messaging format
            if (Object.keys(llmResult.tool_calls).length > 0 ) {
                // Format tool_calls object into an array
                newAssistantChatMessage.tool_calls = Object.values(llmResult.tool_calls);
            }

            //console.info("newChatMessage before saving to dynamo\n" + JSON.stringify(newAssistantChatMessage, null, 2));    

            // Save LLM result prompt to the database            
            await savePrompt(ddbDocClient, connectionId, newAssistantChatMessage);

            // If this is a tool call, format the results for
            // additional downstream processing and invoke State Machine
            if (Object.keys(llmResult.tool_calls).length > 0 ) {

                // Invoke State Machine to call tool(s)
                await invokeStateMachine(llmResult.tool_calls, connectionId, callConnection, ws_domain_name, ws_stage);

                // Inject text to speech here or a waiting sound to account for delay  
                // in response from tool call. This could be personalize and run optionally
                // depending to the tool call(s). Latency could be low enough
                // that this is not needed.
                
                // Speech Delay
                /*
                const timeFillers = ["One second.", "I'll get that.", "Working on that.", "One moment.", "Just a sec.", "Getting that."];
                await replyToWS(ws_client, connectionId, {   
                    type:"text",
                    token: timeFillers[ ( Math.floor (Math.random() * timeFillers.length) ) ], 
                    last: true
                });
                */

                // Recorded File Delay (with mp3 file)         
                /*       
                await replyToWS(ws_client, connectionId, {   
                    "type":"play",
                    "source": process.env.TOOL_CALL_WAITING_MP3, // required link to mp3 file like "https://api.twilio.com/cowbell.mp3"
                    "loop": 1,
                    "preemptible": true // Default is false
                });
                */
            }

        } else if (body?.type === "interrupt") {

            /**
             * "interrupt" event sent by the ConversationRelay server when the user speaks 
             * before the text-to-speech has completed.
             * 
             * {
             *  "type" : "interrupt",
             *  "utteranceUntilInterrupt": "Life is a complex set of",
             *  "durationUntilInterruptMs": "460"
             * }
             * 
             * This implementation does not track interruptions.
             * 
             */

            // PUT records
            // pk = event.requestContext.connectionId 
            // sk = interrupt
            // ts = unix timestamp
     
        } else if (body?.type === "setup") {

            /**
             * "setup" event sent from ConversationRelay server as initial session message.
             * This event can be used for additional configuration for this call.
             * 
             * {
             *  "type": "setup",
             *  "sessionId": "VXxxx",
             *  "callSid": "CAxxxx",
             *  "parentCallSid": null,
             *  "from": "+14085551212",
             *  "to": "+18881234567",
             *  "forwardedFrom": null,
             *  "callerName": null,
             *  "direction": "inbound",
             *  "callType": "PSTN",
             *  "callStatus": "IN-PROGRESS",
             *  "accountSid": "ACxxx",
             *  "applicationSid": "APxxx"
             * }
             * 
             * This implementation does utilize the setup event.
             */
            
            // PUT record
            // pk = event.requestContext.connectionId 
            // sk = setup
            
        } else if (body?.type === "end") {

            /**
             * "end" event is the last message sent by the ConversationRelay server. This
             * message can be used for any "clean up" processing.
             * 
             * {
             *  "type" : "end",
             *  "handoffData": "{\"reasonCode\":\"live-agent-handoff\", \"reason\": \"The caller wants to talk to a real person\"}"
             * }
             * 
             * This implementation does not use the end event.
             */

            // PUT record
            // pk = event.requestContext.connectionId 
            // sk = end
            
        }
    
        return { statusCode: 200, body: 'Completed.' };

    } catch (error) {
        
        console.log("Default Route app.js generated an error => ", error);
        
        return { statusCode: 500, body: 'Default app.js generated an error: ' + JSON.stringify(error) };

    }  

};