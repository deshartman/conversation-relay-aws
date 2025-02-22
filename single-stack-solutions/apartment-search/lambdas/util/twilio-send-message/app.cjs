/**
 *  twilio-send-message
 * 
 *
 */

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = require('twilio')(accountSid, authToken);

exports.lambdaHandler = async function (event, context) { 

  let snsPayload = JSON.parse(event.Records[0].Sns.Message);  

  console.info("EVENT\n" + JSON.stringify(event, null, 2));    
  console.info("Message\n" + JSON.stringify(snsPayload, null, 2));    

  // Format and execute api call to Twilio  
  const messageResponse = await twilioClient.messages.create({
    to: snsPayload.To,
    from: snsPayload.From,
    body: snsPayload.MessageBody,
  });       
  console.log("messageResponse => ", messageResponse);

  return true;

};