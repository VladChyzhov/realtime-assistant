import { contextBridge } from 'electron';
import { createEphemeralKey } from './utils/openai.js';

contextBridge.exposeInMainWorld('api', {
  createEphemeralKey,
});
