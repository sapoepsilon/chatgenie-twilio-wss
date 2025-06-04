import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { createClient } from "@supabase/supabase-js";
import { OpenAIAnswerer } from "./openaiAnswerer.js";
import { GeminiAnswerer } from "./geminiAnswerer.js";

// Load environment variables from .env file
dotenv.config();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
let SYSTEM_MESSAGE =
  "Keep your answers really short, try to answer with 1 word if possible but remain helpul to the customer. And try to listen what the other side is saying, please. You are a receiptionist. ";
const VOICE = "alloy";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
let TWILIO_CALL_ID;

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all("/incoming-call", async (request, reply) => {
  const phoneNumber = request.body.From || request.body.Caller;
  const toPhoneNumber = request.body.Called;
  const direction = request.body.Direction;
  const callSid = request.body.CallSid;
  const fromCity = request.body.FromCity;
  const fromState = request.body.FromState;
  const fromCountry = request.body.FromCountry;
  const callToken = request.body.CallToken;
  let businessId = null;
  // Assuming phoneNumber is the actual phone number as a string
  console.log(
    "Incoming call from:",
    phoneNumber,
    "to",
    toPhoneNumber,
    "Direction:",
    direction,
    "Call SID:",
    callSid,
    "From City:",
    fromCity,
    "From State:",
    fromState,
    "From Country:",
    fromCountry,
    "Call Token:",
    callToken
  );

  try {
    const { data: bussinessPhoneData, error: bussinessPhoneError } =
      await supabase
        .from("business_phone_numbers")
        .select("business_id")
        .eq("phone_number", toPhoneNumber);

    // Log the data
    console.log(`bussinessPhoneData: ${JSON.stringify(bussinessPhoneData)}`);
    // Extract the business_id from the first object in the array
    if (bussinessPhoneData.length > 0) {
      businessId = bussinessPhoneData[0].business_id;
    } else {
      businessId = undefined; // Handle case where array is empty
    }

    console.log(`businessId: ${businessId}`);
  } catch (error) {
    console.error(`Error fetching business phone number: ${error.message}`);
  }

  try {
    const { data: businessData, error: bussinessDataError } = await supabase
      .from("businesses")
      .select()
      .eq("id", businessId);

    console.log(`businessData: ${JSON.stringify(businessData)}`);
    // Extract the business_id from the first object in the array
    if (businessData.length > 0) {
      try {
        const businessHours = parseHours(businessData[0].week_schedule);
        console.log(`businessHours: ${businessHours}`);
        SYSTEM_MESSAGE += `Business name is ${businessData[0].business_name}. `;
        SYSTEM_MESSAGE += `Business's schedule is  ${businessHours} `;
        SYSTEM_MESSAGE += `Business tele operator instructions are ${businessData[0].tele_operator_instructions}. `;
      } catch (error) {
        console.error("Failed to parse business hours:", error);
        SYSTEM_MESSAGE +=
          "Business schedule information is unavailable due to a data error. ";
      }
    } else {
      businessId = undefined; // Handle case where array is empty
    }

    console.log(`buiness system message : ${SYSTEM_MESSAGE}`);
  } catch (error) {
    console.error(
      `Error fetching business phone number: ${JSON.stringify(error)}`
    );
  }

  try {
    // Step 1: Check if the phone number exists in the 'phone_numbers' table
    const { data: phoneData, error: phoneError } = await supabase
      .from("phone_numbers")
      .select("id")
      .eq("number", phoneNumber)
      .single(); // Expecting a single record

    if (phoneError) {
      console.error(`Error fetching phone number: ${phoneError.message}`);
    }
    console.log("phoneData", phoneData);
    let phoneNumberId;

    // Step 2: If the phone number doesn't exist, insert it into 'phone_numbers'
    try {
      if (!phoneData) {
        const { data: newPhone, error: insertPhoneError } = await supabase
          .from("phone_numbers")
          .insert([{ number: phoneNumber, name: "Unknown" }]) // Set name if applicable
          .select()
          .single(); // Retrieve the newly inserted phone number ID

        if (insertPhoneError) {
          throw new Error(
            `Error inserting phone number: ${insertPhoneError.message}`
          );
        }

        phoneNumberId = newPhone.id;
      } else {
        // If the phone number exists, use its ID
        phoneNumberId = phoneData.id;
      }
    } catch (error) {
      console.error("Error during phone number handling:", error);
      return; // Exit if there's an error in handling phone number
    }

    // Step 3: Insert the call record into 'calls' using the 'phone_number_id'
    try {
      const { data: callInfo, error: callError } = await supabase
        .from("calls")
        .insert([
          {
            phone_number_id: phoneNumberId, // Use the ID of the phone number
            date: new Date().toISOString().split("T")[0], // Current date in ISO format
            time: new Date().toLocaleTimeString("en-GB", { hour12: false }), // Current time in 24-hour format
            duration: "00:00:00",
          },
        ])
        .select()
        .single();

      console.log("callInfo", callInfo);
      TWILIO_CALL_ID = callInfo.id;

      if (callError) {
        console.error(`Error inserting call record: ${callError.message}`);
      }

      console.log("Call record inserted successfully!");
    } catch (error) {
      console.error("Error inserting call record:", error);
    }
  } catch (error) {
    console.error("Unexpected error occurred:", error);
  }
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while I connect you to our AI assistant powered by Gemini</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Route for Twilio to handle incoming calls with Gemini
fastify.all("/incoming-call-gemini", async (request, reply) => {
  const phoneNumber = request.body.From || request.body.Caller;
  const toPhoneNumber = request.body.Called;
  const direction = request.body.Direction;
  const callSid = request.body.CallSid;
  const fromCity = request.body.FromCity;
  const fromState = request.body.FromState;
  const fromCountry = request.body.FromCountry;
  const callToken = request.body.CallToken;
  let businessId = null;
  
  console.log(
    "Incoming call (Gemini) from:",
    phoneNumber,
    "to",
    toPhoneNumber,
    "Direction:",
    direction,
    "Call SID:",
    callSid,
    "From City:",
    fromCity,
    "From State:",
    fromState,
    "From Country:",
    fromCountry,
    "Call Token:",
    callToken
  );

  // Same business logic as the OpenAI route
  try {
    const { data: bussinessPhoneData, error: bussinessPhoneError } =
      await supabase
        .from("business_phone_numbers")
        .select("business_id")
        .eq("phone_number", toPhoneNumber);

    console.log(`bussinessPhoneData: ${JSON.stringify(bussinessPhoneData)}`);
    if (bussinessPhoneData.length > 0) {
      businessId = bussinessPhoneData[0].business_id;
    } else {
      businessId = undefined;
    }

    console.log(`businessId: ${businessId}`);
  } catch (error) {
    console.error(`Error fetching business phone number: ${error.message}`);
  }

  try {
    const { data: businessData, error: bussinessDataError } = await supabase
      .from("businesses")
      .select()
      .eq("id", businessId);

    console.log(`businessData: ${JSON.stringify(businessData)}`);
    if (businessData.length > 0) {
      try {
        const businessHours = parseHours(businessData[0].week_schedule);
        console.log(`businessHours: ${businessHours}`);
        SYSTEM_MESSAGE += `Business name is ${businessData[0].business_name}. `;
        SYSTEM_MESSAGE += `Business's schedule is  ${businessHours} `;
        SYSTEM_MESSAGE += `Business tele operator instructions are ${businessData[0].tele_operator_instructions}. `;
      } catch (error) {
        console.error("Failed to parse business hours:", error);
        SYSTEM_MESSAGE +=
          "Business schedule information is unavailable due to a data error. ";
      }
    } else {
      businessId = undefined;
    }

    console.log(`buiness system message : ${SYSTEM_MESSAGE}`);
  } catch (error) {
    console.error(
      `Error fetching business phone number: ${JSON.stringify(error)}`
    );
  }

  // Same phone number and call tracking logic
  try {
    const { data: phoneData, error: phoneError } = await supabase
      .from("phone_numbers")
      .select("id")
      .eq("number", phoneNumber)
      .single();

    if (phoneError) {
      console.error(`Error fetching phone number: ${phoneError.message}`);
    }
    console.log("phoneData", phoneData);
    let phoneNumberId;

    try {
      if (!phoneData) {
        const { data: newPhone, error: insertPhoneError } = await supabase
          .from("phone_numbers")
          .insert([{ number: phoneNumber, name: "Unknown" }])
          .select()
          .single();

        if (insertPhoneError) {
          throw new Error(
            `Error inserting phone number: ${insertPhoneError.message}`
          );
        }

        phoneNumberId = newPhone.id;
      } else {
        phoneNumberId = phoneData.id;
      }
    } catch (error) {
      console.error("Error during phone number handling:", error);
      return;
    }

    try {
      const { data: callInfo, error: callError } = await supabase
        .from("calls")
        .insert([
          {
            phone_number_id: phoneNumberId,
            date: new Date().toISOString().split("T")[0],
            time: new Date().toLocaleTimeString("en-GB", { hour12: false }),
            duration: "00:00:00",
          },
        ])
        .select()
        .single();

      console.log("callInfo", callInfo);
      TWILIO_CALL_ID = callInfo.id;

      if (callError) {
        console.error(`Error inserting call record: ${callError.message}`);
      }

      console.log("Call record inserted successfully!");
    } catch (error) {
      console.error("Error inserting call record:", error);
    }
  } catch (error) {
    console.error("Unexpected error occurred:", error);
  }
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while I connect you to our AI assistant powered by Gemini</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream-gemini" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream (now using Gemini)
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, async (connection, req) => {
    console.log("Client connected to Gemini stream");
    
    try {
      const geminiAnswerer = new GeminiAnswerer(SYSTEM_MESSAGE, "Puck");
      await geminiAnswerer.createLiveSession();
      
      let streamSid = null;

      // Handle incoming messages from Twilio
      connection.on("message", async (message) => {
        try {
          const data = JSON.parse(message);
          
          switch (data.event) {
            case "media":
              // Send audio to Gemini
              await geminiAnswerer.handleTwilioAudio(
                data.media.payload,
                // Transcript callback
                async (transcript, isAgent) => {
                  try {
                    const { err } = await supabase.from("transcripts").insert([
                      {
                        call_id: TWILIO_CALL_ID,
                        text: transcript,
                        is_agent: isAgent,
                      },
                    ]);
                    if (err) {
                      console.error(`Error inserting ${isAgent ? 'assistant' : 'user'} transcript:`, err);
                    }
                  } catch (error) {
                    console.error(
                      `Exception caught during ${isAgent ? 'assistant' : 'user'} transcript insertion:`,
                      error
                    );
                  }
                },
                // Audio response callback
                (audioBuffer) => {
                  if (audioBuffer && streamSid) {
                    const base64Audio = geminiAnswerer.convertAudioForTwilio(audioBuffer);
                    if (base64Audio) {
                      const audioDelta = {
                        event: "media",
                        streamSid: streamSid,
                        media: {
                          payload: base64Audio,
                        },
                      };
                      connection.send(JSON.stringify(audioDelta));
                    }
                  }
                }
              );
              break;
              
            case "start":
              streamSid = data.start.streamSid;
              console.log("Incoming Gemini stream has started", streamSid);
              break;
              
            case "stop":
              console.log("Twilio stream stopped - signaling end to Gemini");
              geminiAnswerer.endAudioStream();
              break;
              
            default:
              console.log("Received non-media event:", data.event);
              break;
          }
        } catch (error) {
          console.error("Error parsing Gemini message:", error, "Message:", message);
        }
      });

      // Handle connection close
      connection.on("close", (call) => {
        geminiAnswerer.close();
        console.log(`Gemini call ${call} ended`);
        supabase
          .from("calls")
          .update({ duration: "00:05:00" })
          .eq("id", TWILIO_CALL_ID);
      });

    } catch (error) {
      console.error("Error setting up Gemini connection:", error);
      connection.close();
    }
  });
});

// WebSocket route for Gemini media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream-gemini", { websocket: true }, async (connection, req) => {
    console.log("Client connected to Gemini stream");
    
    try {
      const geminiAnswerer = new GeminiAnswerer(SYSTEM_MESSAGE, "Puck");
      await geminiAnswerer.createLiveSession();
      
      let streamSid = null;

      // Handle incoming messages from Twilio
      connection.on("message", async (message) => {
        try {
          const data = JSON.parse(message);
          
          switch (data.event) {
            case "media":
              // Send audio to Gemini
              await geminiAnswerer.handleTwilioAudio(
                data.media.payload,
                // Transcript callback
                async (transcript, isAgent) => {
                  try {
                    const { err } = await supabase.from("transcripts").insert([
                      {
                        call_id: TWILIO_CALL_ID,
                        text: transcript,
                        is_agent: isAgent,
                      },
                    ]);
                    if (err) {
                      console.error(`Error inserting ${isAgent ? 'assistant' : 'user'} transcript:`, err);
                    }
                  } catch (error) {
                    console.error(
                      `Exception caught during ${isAgent ? 'assistant' : 'user'} transcript insertion:`,
                      error
                    );
                  }
                },
                // Audio response callback (for future TTS integration)
                (audioBuffer) => {
                  if (audioBuffer && streamSid) {
                    const base64Audio = geminiAnswerer.convertAudioForTwilio(audioBuffer);
                    if (base64Audio) {
                      const audioDelta = {
                        event: "media",
                        streamSid: streamSid,
                        media: {
                          payload: base64Audio,
                        },
                      };
                      connection.send(JSON.stringify(audioDelta));
                    }
                  }
                }
              );
              break;
              
            case "start":
              streamSid = data.start.streamSid;
              console.log("Incoming Gemini stream has started", streamSid);
              break;
              
            default:
              console.log("Received non-media event:", data.event);
              break;
          }
        } catch (error) {
          console.error("Error parsing Gemini message:", error, "Message:", message);
        }
      });

      // Handle connection close
      connection.on("close", (call) => {
        geminiAnswerer.close();
        console.log(`Gemini call ${call} ended`);
        supabase
          .from("calls")
          .update({ duration: "00:05:00" })
          .eq("id", TWILIO_CALL_ID);
      });

    } catch (error) {
      console.error("Error setting up Gemini connection:", error);
      connection.close();
    }
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});

function parseHours(data) {
  let result = "";

  for (const [day, hours] of Object.entries(data)) {
    if (hours.isOpen) {
      result += `${day}: Open from ${hours.openingTime || "N/A"} to ${
        hours.closingTime || "N/A"
      }\n`;
    } else {
      result += `${day}: Closed\n`;
    }
  }

  return result.trim(); // Remove trailing newline
}
