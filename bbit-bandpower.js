import FFT from 'fft.js';

export class BandPowerEstimator {
  constructor({ fs, windowSec, overlap = 0.5, minHz = 0.5, maxHz = 45, notchHz, notchWidth = 1 }) {
    if (!fs) throw new Error('fs required');
    this.fs = fs;
    this.winSize = 256;
    this.hopSize = Math.max(1, Math.round(this.winSize * (1 - overlap)));
    this.buffer = [];
    this.minHz = minHz; this.maxHz = maxHz; this.notchHz = notchHz; this.notchWidth = notchWidth;

    this.hann = new Float64Array(this.winSize);
    for (let n=0;n<this.winSize;n++) this.hann[n] = 0.5 * (1 - Math.cos((2*Math.PI*n)/(this.winSize-1)));

    this.fft = new FFT(this.winSize);
    this.spectrum = new Float64Array(this.winSize/2 + 1);
    this.freqs = new Float64Array(this.winSize/2 + 1);
    for (let k=0;k<this.freqs.length;k++) this.freqs[k] = (k*this.fs)/this.winSize;
  }
  addSamples(samples) {
    for (let i=0;i<samples.length;i++) this.buffer.push(samples[i]);
    let last = null;
    while (this.buffer.length >= this.winSize) {
      const seg = this.buffer.slice(0, this.winSize);
      const mean = seg.reduce((a,b)=>a+b,0)/seg.length;
      for (let i=0;i<seg.length;i++) seg[i] = (seg[i]-mean) * this.hann[i];

      const N = this.winSize;
      const data = this.fft.createComplexArray();
      const out  = this.fft.createComplexArray();
      for (let i=0;i<N;i++){ data[2*i] = seg[i]; data[2*i+1] = 0; }
      this.fft.realTransform(out, data);
      this.fft.completeSpectrum(out);

      const windowPower = this.hann.reduce((a,b)=>a+b*b,0);
      const scale = 1/(N*N*(windowPower/N));
      for (let k=0;k<=N/2;k++){ const re=out[2*k], im=out[2*k+1]; this.spectrum[k] = (re*re + im*im) * scale; }

      if (this.notchHz) {
        for (let k=0;k<this.spectrum.length;k++){ const f=this.freqs[k]; if (Math.abs(f - this.notchHz) <= this.notchWidth/2) this.spectrum[k] = 0; }
      }

      const total = this._integrate(this.minHz, this.maxHz);
      const bandsDef = { delta:[0.5,4], theta:[4,8], alpha:[8,12], beta:[12,30], gamma:[30,45] };
      const outBands = {};
      for (const [name,[f1,f2]] of Object.entries(bandsDef)) {
        const p = this._integrate(f1, f2);
        outBands[name] = { abs: p, rel: total>0 ? p/total : 0 };
      }
      last = { fs: this.fs, windowSize: N, totalPower: total, bands: outBands };
      this.buffer = this.buffer.slice(this.hopSize);
    }
    return last;
  }
  _integrate(fmin,fmax){
    let sum=0, pf=null, pp=null;
    for (let k=0;k<this.spectrum.length;k++){
      const f=this.freqs[k];
      if (f<fmin) continue;
      if (f>fmax) break;
      const p=this.spectrum[k];
      if (pf!=null) sum += ((p+pp)/2)*(f-pf);
      pf=f; pp=p;
    }
    return sum;
  }
  bandAbs(f1,f2){ return this._integrate(f1,f2); }
  bandRel(f1,f2, d1=1, d2=30){ const num=this._integrate(f1,f2); const den=this._integrate(d1,d2); return den>0? num/den : 0; }
}
