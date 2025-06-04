import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { AudioConverter } from './audioConverter.js';
import dotenv from 'dotenv';

dotenv.config();

export class GeminiAnswerer {
  constructor(systemMessage, voice = "Puck", apiKey = process.env.GEMINI_API_KEY) {
    this.systemMessage = systemMessage;
    this.voice = voice;
    this.apiKey = apiKey;
    this.ai = new GoogleGenAI({ apiKey: apiKey });
    this.session = null;
    this.responseQueue = [];
    this.onTranscript = null;
    this.onAudioResponse = null;
    this.isProcessingTurn = false;
    
    if (!this.apiKey) {
      console.error("Missing Gemini API key. Please set it in the .env file.");
      throw new Error("GEMINI_API_KEY is required");
    }
  }

  async createLiveSession() {
    try {
      const model = 'gemini-2.0-flash-live-001';
      const config = {
        responseModalities: [Modality.AUDIO], 
        inputAudioTranscription: {}, 
        outputAudioTranscription: {}, 
        systemInstruction: this.systemMessage,
        speechConfig: {
          voiceConfig: { 
            prebuiltVoiceConfig: { 
              voiceName: this.voice 
            } 
          }
        }
        // Removed custom VAD config - let Gemini handle it automatically
      };

      this.session = await this.ai.live.connect({
        model: model,
        config: config,
        callbacks: {
          onopen: () => {
            console.log('Gemini Live session opened and ready for audio streaming');
          },
          onmessage: (message) => {
            console.log('Received message from Gemini:', JSON.stringify(message, null, 2));
            this.responseQueue.push(message);
            
            // Start processing turn if we're not already processing and this looks like a turn
            if (!this.isProcessingTurn && message.serverContent) {
              this.processTurn();
            }
          },
          onerror: (error) => {
            console.error('Gemini Live session error:', error);
          },
          onclose: (event) => {
            console.log('Gemini Live session closed:', event.reason);
          },
        }
      });
      
      console.log("Gemini Live session created successfully");
      return this.session;
    } catch (error) {
      console.error("Error creating Gemini Live session:", error);
      throw error;
    }
  }

  async sendAudio(base64MulawData, onTranscript, onAudioResponse) {
    try {
      if (!this.session) {
        await this.createLiveSession();
      }

      // Store callbacks for message handling
      this.onTranscript = onTranscript;
      this.onAudioResponse = onAudioResponse;

      // Convert Twilio μ-law to Gemini PCM format
      const pcmBuffer = AudioConverter.twilioToGemini(base64MulawData);
      
      if (!pcmBuffer) {
        console.error("Failed to convert audio format");
        return;
      }

      // Only log occasionally to avoid spam
      if (Math.random() < 0.01) { // Log ~1% of audio chunks
        console.log(`Sending ${pcmBuffer.length} bytes of PCM audio to Gemini`);
      }

      // Send audio to Gemini using sendRealtimeInput
      this.session.sendRealtimeInput({
        audio: {
          data: pcmBuffer.toString('base64'),
          mimeType: "audio/pcm;rate=16000"
        }
      });

    } catch (error) {
      console.error("Error sending audio to Gemini:", error);
      throw error;
    }
  }

  // Method to signal end of audio stream (for silence detection)
  endAudioStream() {
    if (this.session) {
      console.log("Signaling end of audio stream to Gemini");
      this.session.sendRealtimeInput({ audioStreamEnd: true });
    }
  }

  // Queue processing methods from the docs
  async waitMessage() {
    let done = false;
    let message = undefined;
    while (!done) {
      message = this.responseQueue.shift();
      if (message) {
        done = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return message;
  }

  async processTurn() {
    if (this.isProcessingTurn) return;
    
    this.isProcessingTurn = true;
    console.log("Starting turn processing...");
    
    try {
      const turns = [];
      let done = false;
      
      while (!done) {
        const message = await this.waitMessage();
        turns.push(message);
        
        if (message.serverContent && message.serverContent.turnComplete) {
          console.log("Turn completed, processing messages...");
          done = true;
        }
      }
      
      // Process all messages in the turn
      for (const turn of turns) {
        this.handleGeminiMessage(turn);
      }
      
    } catch (error) {
      console.error("Error processing turn:", error);
    } finally {
      this.isProcessingTurn = false;
    }
  }

  handleGeminiMessage(message) {
    try {
      // Handle server content messages
      if (message.serverContent) {
        // Handle input transcription (user speech)
        if (message.serverContent.inputTranscription) {
          console.log("User transcription:", message.serverContent.inputTranscription.text);
          if (this.onTranscript) {
            this.onTranscript(message.serverContent.inputTranscription.text, false); // isAgent = false
          }
        }

        // Handle output transcription (assistant speech)
        if (message.serverContent.outputTranscription) {
          console.log("Assistant transcription:", message.serverContent.outputTranscription.text);
          if (this.onTranscript) {
            this.onTranscript(message.serverContent.outputTranscription.text, true); // isAgent = true
          }
        }

        // Handle model turn with parts
        if (message.serverContent.modelTurn && message.serverContent.modelTurn.parts) {
          for (const part of message.serverContent.modelTurn.parts) {
            if (part.text) {
              console.log("Gemini text response:", part.text);
              if (this.onTranscript) {
                this.onTranscript(part.text, true); // isAgent = true
              }
            }
            
            if (part.inlineData && part.inlineData.mimeType === "audio/pcm;rate=24000") {
              console.log("Received audio data from Gemini");
              if (this.onAudioResponse) {
                // Convert base64 audio data to buffer
                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                this.onAudioResponse(audioBuffer);
              }
            }
          }
        }

        // Handle turn completion
        if (message.serverContent.turnComplete) {
          console.log("Turn completed");
        }

        // Handle interruptions
        if (message.serverContent.interrupted) {
          console.log("Response was interrupted");
        }
      }

      // Handle direct text responses
      if (message.text) {
        console.log("Gemini direct text response:", message.text);
        if (this.onTranscript) {
          this.onTranscript(message.text, true); // isAgent = true
        }
      }

      // Handle direct audio data
      if (message.data) {
        console.log("Received direct audio data from Gemini");
        if (this.onAudioResponse) {
          // Convert base64 audio data to buffer
          const audioBuffer = Buffer.from(message.data, 'base64');
          this.onAudioResponse(audioBuffer);
        }
      }

    } catch (error) {
      console.error("Error handling Gemini message:", error, message);
    }
  }

  close() {
    if (this.session) {
      console.log("Closing Gemini session");
      this.session.close();
      this.session = null;
    }
  }

  // Handle incoming audio from Twilio
  async handleTwilioAudio(base64AudioData, onTranscript, onAudioResponse) {
    return this.sendAudio(base64AudioData, onTranscript, onAudioResponse);
  }

  // Convert Gemini audio response back to Twilio format
  convertAudioForTwilio(geminiAudioBuffer) {
    return AudioConverter.geminiToTwilio(geminiAudioBuffer);
  }
}