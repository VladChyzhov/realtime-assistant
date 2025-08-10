export function initVAD(stream,{threshold=0.01}={}){
  const ctx=new AudioContext();
  const source=ctx.createMediaStreamSource(stream);
  const analyser=ctx.createAnalyser();
  analyser.fftSize=2048;
  source.connect(analyser);
  const data=new Uint8Array(analyser.fftSize);
  function isSpeech(){
    analyser.getByteTimeDomainData(data);
    let sum=0;for(let i=0;i<data.length;i++){const v=(data[i]-128)/128;sum+=v*v;}
    return Math.sqrt(sum/data.length)>threshold;
  }
  return {isSpeech};
}
