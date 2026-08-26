import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const DURATION_SEC = 1;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const AMPLITUDE = 0.5 * 32767;

const SAMPLE_DIR = path.dirname(fileURLToPath(import.meta.url));

function writeSineWav(filePath, frequencyHz) {
  const numSamples = SAMPLE_RATE * DURATION_SEC;
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = numSamples * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const samples = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const value = Math.round(AMPLITUDE * Math.sin(2 * Math.PI * frequencyHz * t));
    samples.writeInt16LE(value, i * blockAlign);
  }

  fs.writeFileSync(filePath, Buffer.concat([header, samples]));
}

writeSineWav(path.join(SAMPLE_DIR, 'Fixture Artist - Test Tone A.wav'), 440);
writeSineWav(path.join(SAMPLE_DIR, 'Fixture Artist - Test Tone B.wav'), 554);

console.log('Wrote fixture WAV files to', SAMPLE_DIR);
