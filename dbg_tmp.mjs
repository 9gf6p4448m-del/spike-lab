import fs from 'node:fs';
import { selectSpiker, cleanFrames, detectSpikes, imageSeries } from './site/js/metrics.js';
const res = JSON.parse(fs.readFileSync('ref-clips/_frames/france_ngapeth.mp4.json'));
const frames = cleanFrames(selectSpiker(res.frames));
const ser = imageSeries(frames);
for (let i=0;i<frames.length;i++){
  console.log(i, 'world='+!!frames[i].world, 'hL='+ser.h.L[i]?.toFixed(2), 'hR='+ser.h.R[i]?.toFixed(2), 'spL='+ser.speed.L[i]?.toFixed(2),'spR='+ser.speed.R[i]?.toFixed(2));
}
