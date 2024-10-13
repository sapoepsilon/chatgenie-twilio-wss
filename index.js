import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js'

// Load environment variables from .env file
dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'Keep your answers really short, try to answer with 1 word if possible. And try to listen what the other side is saying, please. You are a receiptionist for Utah Junk Movers. Utah Junk Movers works from 6am to 11pm. We operate in Salt Lake County only in Utah. We work from Monday to Saturday. We have a minimum chahrge of $120. And we chagne $40 per cubic';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
let TWILIO_CALL_ID;
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const phoneNumber = request.body.From || request.body.Caller;
    const direction = request.body.Direction;
    const callSid = request.body.CallSid;
    const fromCity = request.body.FromCity;
    const fromState = request.body.FromState;
    const fromCountry = request.body.FromCountry;
    const callToken = request.body.CallToken;
    // Assuming phoneNumber is the actual phone number as a string
    console.log('Incoming call from:', phoneNumber, 'Direction:', direction, 'Call SID:', callSid, 'From City:', fromCity, 'From State:', fromState, 'From Country:', fromCountry, 'Call Token:', callToken);

    try {
        // Step 1: Check if the phone number exists in the 'phone_numbers' table
        const { data: phoneData, error: phoneError } = await supabase
            .from('phone_numbers')
            .select('id')
            .eq('number', phoneNumber)
            .single();  // Expecting a single record

        if (phoneError) {
            console.error(`Error fetching phone number: ${phoneError.message}`);
        }
        console.log('phoneData', phoneData);
        let phoneNumberId;

        // Step 2: If the phone number doesn't exist, insert it into 'phone_numbers'
        try {
            if (!phoneData) {
                const { data: newPhone, error: insertPhoneError } = await supabase
                    .from('phone_numbers')
                    .insert([{ number: phoneNumber, name: 'Unknown' }])  // Set name if applicable
                    .select()
                    .single();  // Retrieve the newly inserted phone number ID

                if (insertPhoneError) {
                    throw new Error(`Error inserting phone number: ${insertPhoneError.message}`);
                }

                phoneNumberId = newPhone.id;
            } else {
                // If the phone number exists, use its ID
                phoneNumberId = phoneData.id;
            }
        } catch (error) {
            console.error('Error during phone number handling:', error);
            return; // Exit if there's an error in handling phone number
        }

        // Step 3: Insert the call record into 'calls' using the 'phone_number_id'
        try {
            const { data: callInfo, error: callError } = await supabase.from('calls').insert([
                {
                    phone_number_id: phoneNumberId,   // Use the ID of the phone number
                    date: new Date().toISOString().split('T')[0],   // Current date in ISO format
                    time: new Date().toLocaleTimeString('en-GB', { hour12: false }),   // Current time in 24-hour format
                    duration: '00:00:00'
                }
            ])
                .select()
                .single();

            console.log('callInfo', callInfo);
            TWILIO_CALL_ID = callInfo.id;

            if (callError) {
                console.error(`Error inserting call record: ${callError.message}`);
            }

            console.log('Call record inserted successfully!');
        } catch (error) {
            console.error('Error inserting call record:', error);
        }
    } catch (error) {
        console.error('Unexpected error occurred:', error);
    }
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while I connect you to our reciptionist</Say>
                              <Pause length="1"/>
                              <Say>O.K. you can start talking!</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    input_audio_transcription: {
                        "model": "whisper-1"
                    },
                    turn_detection: { type: 'server_vad' },
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                console.log('response', response);
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }

                if (response.type === 'conversation.item.created') {
                    const item = JSON.parse(response.item);
                    console.log('response iem data:', item);
                }

                if (response.type === 'conversation.item.input_audio_transcription.completed') {
                    console.log('User transcription:', response.transcript);
                    const insertTranscript = async () => {
                        const { err } = await supabase.from('transcripts').insert([
                            {
                                call_id: TWILIO_CALL_ID,
                                text: response.transcript,
                                is_agent: false
                            }
                        ]);
                        if (err) {
                            console.error('Error inserting user transcript:', err);
                        }
                    };

                    insertTranscript();
                }

                if (response.type === 'response.content_part.done') {
                    console.log('assistant response:', response.part); // TODO: Supabase add to assistant transcript
                    const insertTranscript = async () => {
                        const { err } = await supabase.from('transcripts').insert([
                            {
                                call_id: TWILIO_CALL_ID,
                                text: response.part.transcript,
                                is_agent: true
                            }
                        ]);
                        if (err) {
                            console.error('Error inserting user transcript:', err);
                        }
                    };

                    // Call the insert function without awaiting it
                    insertTranscript();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
            }
        });

        // Handle connection close
        connection.on('close', (call) => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            // TODO: Get call duration and update the 'calls' table
            console.log(`Call ${call} ended`);
            supabase.from('calls').update({ duration: '00:05:00' }).eq('id', TWILIO_CALL_ID); // TODO: request from twilio to get the call information and to update it
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
