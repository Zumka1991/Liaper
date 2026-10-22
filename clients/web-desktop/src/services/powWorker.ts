import { solvePowSync, type PowTask } from './pow';

self.onmessage = (e: MessageEvent<PowTask>) => {
  const { challenge, difficulty } = e.data;
  self.postMessage(solvePowSync(challenge, difficulty));
};
