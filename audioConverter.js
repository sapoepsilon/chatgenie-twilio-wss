import wav from 'node-wav';

class AudioConverter {
  // Convert μ-law 8kHz base64 (from Twilio) to 16-bit PCM 16kHz (for Gemini)
  static twilioToGemini(base64MulawData) {
    try {
      // Decode base64 to buffer
      const mulawBuffer = Buffer.from(base64MulawData, 'base64');
      
      // Convert μ-law to 16-bit PCM
      const pcmBuffer = this.mulawToPcm16(mulawBuffer);
      
      // Resample from 8kHz to 16kHz (double the data)
      const resampledBuffer = this.resample8kTo16k(pcmBuffer);
      
      return resampledBuffer;
    } catch (error) {
      console.error('Error converting Twilio audio to Gemini format:', error);
      return null;
    }
  }
  
  // Convert 16-bit PCM 24kHz (from Gemini) to μ-law 8kHz base64 (for Twilio)
  static geminiToTwilio(pcm24kBuffer) {
    try {
      // Downsample from 24kHz to 8kHz
      const downsampled = this.resample24kTo8k(pcm24kBuffer);
      
      // Convert PCM to μ-law
      const mulawBuffer = this.pcm16ToMulaw(downsampled);
      
      // Encode to base64
      return mulawBuffer.toString('base64');
    } catch (error) {
      console.error('Error converting Gemini audio to Twilio format:', error);
      return null;
    }
  }
  
  // Convert μ-law to 16-bit PCM
  static mulawToPcm16(mulawBuffer) {
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2); // 16-bit = 2 bytes per sample
    
    for (let i = 0; i < mulawBuffer.length; i++) {
      const mulawSample = mulawBuffer[i];
      const pcmSample = this.mulawToPcmSample(mulawSample);
      pcmBuffer.writeInt16LE(pcmSample, i * 2);
    }
    
    return pcmBuffer;
  }
  
  // Convert 16-bit PCM to μ-law
  static pcm16ToMulaw(pcmBuffer) {
    const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2); // 16-bit to 8-bit
    
    for (let i = 0; i < pcmBuffer.length; i += 2) {
      const pcmSample = pcmBuffer.readInt16LE(i);
      const mulawSample = this.pcmToMulawSample(pcmSample);
      mulawBuffer[i / 2] = mulawSample;
    }
    
    return mulawBuffer;
  }
  
  // Simple upsampling from 8kHz to 16kHz (duplicate each sample)
  static resample8kTo16k(pcmBuffer) {
    const resampledBuffer = Buffer.alloc(pcmBuffer.length * 2);
    
    for (let i = 0; i < pcmBuffer.length; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      // Write the same sample twice to double the sample rate
      resampledBuffer.writeInt16LE(sample, i * 2);
      resampledBuffer.writeInt16LE(sample, (i * 2) + 2);
    }
    
    return resampledBuffer;
  }
  
  // Simple downsampling from 24kHz to 8kHz (take every 3rd sample)
  static resample24kTo8k(pcmBuffer) {
    const outputLength = Math.floor(pcmBuffer.length / 6); // 24k to 8k = 1/3, 16-bit = 2 bytes
    const resampledBuffer = Buffer.alloc(outputLength * 2);
    
    for (let i = 0; i < outputLength; i++) {
      // Take every 3rd sample (24kHz / 3 = 8kHz)
      const sourceIndex = i * 6;
      if (sourceIndex < pcmBuffer.length - 1) {
        const sample = pcmBuffer.readInt16LE(sourceIndex);
        resampledBuffer.writeInt16LE(sample, i * 2);
      }
    }
    
    return resampledBuffer;
  }
  
  // μ-law to PCM sample conversion
  static mulawToPcmSample(mulaw) {
    const BIAS = 0x84;
    const CLIP = 32635;
    
    mulaw = ~mulaw;
    const sign = (mulaw & 0x80);
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    
    let sample = mantissa << (exponent + 3);
    sample += BIAS;
    if (exponent !== 0) sample += (1 << (exponent + 2));
    
    return sign ? -sample : sample;
  }
  
  // PCM to μ-law sample conversion
  static pcmToMulawSample(pcm) {
    const BIAS = 0x84;
    const CLIP = 32635;
    
    if (pcm > CLIP) pcm = CLIP;
    if (pcm < -CLIP) pcm = -CLIP;
    
    const sign = (pcm < 0) ? 0x80 : 0x00;
    if (sign) pcm = -pcm;
    pcm += BIAS;
    
    let exponent = 7;
    for (let exp = 7; exp >= 0; exp--) {
      if (pcm >= (256 << exp)) {
        exponent = exp;
        break;
      }
    }
    
    const mantissa = (pcm >> (exponent + 3)) & 0x0F;
    const mulaw = ~(sign | (exponent << 4) | mantissa);
    
    return mulaw & 0xFF;
  }
}

export { AudioConverter };