/* 虚拟舞台渲染器 v3(Three.js r149 UMD + 自写 GLSL,file:// 可用,不联网)。
   画面是一整个舞台:桁架上的 14 盏摇头灯、雾里的体积光束、LED 屏墙、光滑的地面反射、乐队剪影、观众席。Launchpad 只是指挥棒(盘面镜像在 HUD 里)。
   渲染管线(每帧):
     1. 舞台全屏片元(stage shader)——对每个像素发一条射线:求与地面/屏墙的交点;雾中对每束光做"光锥解析求交 + 少量步进"的散射积分
        (相函数前向散射、噪声烟雾、光束内的条纹);屏墙(音频反应的 LED 图案)、墙/地上的光斑与图案(gobo)、地面对屏墙和光束的反射、观众席剪影。
     2. 世界网格:桁架、灯体、乐队剪影(带逆光边缘)、火花与彩带粒子。
     3. 灯口光晕(镜头光斑,含变形镜头横向拉丝)。
     4. 辉光(下采样金字塔 + 上采样叠加)、色彩分级(暗部偏梅红,不偏青)、ACES 色调映射、暗角、胶片颗粒、底鼓时的轻微色散。
   灯光语言:所有颜色来自 director.js 的 rig(音名色盘/和弦色/暖白/金),本文件的 GLSL 常量也受 tools/check_lightlang.js 扫描;青绿色相不出现。
   安静模式(引导期间):director 把所有灯压到 0,只剩低亮度氛围(雾 + 暗屏墙 + 地面微光)。 */
(function () {
  "use strict";
  const THREE = window.THREE, Core = window.LPCore, A = window.LPAudio, Dir = window.LPDirector;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const lin3 = (c, k) => [lin(c[0]) * (k == null ? 1 : k), lin(c[1]) * (k == null ? 1 : k), lin(c[2]) * (k == null ? 1 : k)];
  const WEAK = /Intel|UHD|Iris|Adreno|Mali|SwiftShader|llvmpipe|Software|Basic Render|PowerVR/i;
  const WALL = { z: -17, x: 9.5, y0: 0.5, y1: 9.6 };
  const MAXL = 14;

  const S = {
    ok: false, reason: "", gpu: "", mode: "none", opts: { quality: "auto", reduced: false, perf: false, styleMode: "auto", capture: false, forceGL: false },
    stats: {}, lampPx: [], auditLog: { frames: 0, violations: 0, worst: [], pixel: 0, pixelFrames: 0 }, auditOn: false, busListeners: [], bus: null,
  };
  let renderer, gl, canvas, container, W = 1, H = 1, camera, ortho, rtScene, bloomRT = [], hdr = false;
  let sceneStage, sceneWorld, sceneFlare, sceneComp, sceneBlit;
  let stageMat, flareMat, compMat, downMat, upMat, noiseTex, bandTex, bandData;
  let particles = {}, silh = {}, lampBodies = [], dir, rig, fallback = null;
  const Q = { tier: "high", dyn: 1, steps: 12, bn: 14, bloom: true, reflect: true, crowdL: 3, pixCap: 1.7e6, slowN: 0, fastT: 0, noUpUntil: 0, probeAt: -1, ema: 16.7, lastRender: 0, downgrades: 0 };

  /* ---------- 着色器 ---------- */
  const NOISE_GLSL = "float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }";
  function stageFS(ramp, gold) {
    const v3 = (c) => "vec3(" + c.map((x) => x.toFixed(4)).join(",") + ")";
    return `
#define WALL_Z ${WALL.z.toFixed(1)}
#define WALL_X ${WALL.x.toFixed(1)}
#define WALL_Y0 ${WALL.y0.toFixed(1)}
#define WALL_Y1 ${WALL.y1.toFixed(1)}
#define P0 ${v3(ramp[0])}
#define P1 ${v3(ramp[1])}
#define P2 ${v3(ramp[2])}
#define P3 ${v3(ramp[3])}
#define P4 ${v3(ramp[4])}
#define GOLDC ${v3(gold)}
uniform vec2 uRes; uniform vec3 uCam, uRight, uUp, uFwd; uniform float uTanH, uT;
uniform int uBN; uniform float uSteps, uReflect, uCrowdL, uHq, uGain;
uniform vec4 uBA[${MAXL}]; uniform vec4 uBD[${MAXL}]; uniform vec4 uBC[${MAXL}];
uniform sampler2D uNoise, uBands;
uniform vec4 uWM, uWall, uFx, uAbl;
uniform vec3 uTint, uTint2, uHaze; uniform float uHazeD, uBeat;
uniform vec4 uHit[8]; uniform vec3 uHitC[8];
uniform vec4 uShock[4]; uniform vec3 uShockC[4];
varying vec2 vUv;
${NOISE_GLSL}
vec3 pal(float x){ x=clamp(x,0.,1.)*4.; return x<1.?mix(P0,P1,x):(x<2.?mix(P1,P2,x-1.):(x<3.?mix(P2,P3,x-2.):mix(P3,P4,x-3.))); }
float hazeAt(vec3 p){ float n=texture2D(uNoise,p.xz*0.05+vec2(p.y*0.04,uT*0.006)).r; if(uHq>0.5) n=n*0.65+texture2D(uNoise,p.zx*0.13+vec2(-uT*0.011,p.y*0.07)).g*0.35; return uHazeD*(0.2+2.2*n*n)*exp(-max(p.y,0.)*0.05); }

/* ---- LED 屏墙:四种图案按风格加权混合(极光 / 均衡器 / 冲击环与射线 / 盘面按键的彗星) ---- */
vec3 ledWall(vec2 uv,float fp,float soft){
  if(uAbl.x>0.5) return vec3(0.);
  float asp=2.*WALL_X/(WALL_Y1-WALL_Y0); vec2 q=vec2((uv.x-.5)*asp,uv.y-.5); vec3 col=vec3(0.);
  float n1=texture2D(uNoise,vec2(q.x*0.28+uT*0.010,q.y*0.45-uT*0.008)).r;
  float n2=texture2D(uNoise,vec2(q.x*0.6-uT*0.017+n1*0.5,q.y*0.7+uT*0.006)).g;
  float f=smoothstep(0.22,0.85,n1*0.55+n2*0.55);
  col+=mix(pal(f),uTint,0.45)*(0.06+1.0*f*f)*uWM.x;
  if(uWM.y>0.01){
    float bi=floor(uv.x*40.); float bv=texture2D(uBands,vec2((bi+.5)/40.,.5)).r; float h=bv*0.92;
    float cx=fract(uv.x*40.); float on=step(uv.y,h)*step(0.14,cx)*step(cx,0.86)*step(0.2,fract(uv.y*30.));
    vec3 ec=mix(pal(0.04+uv.y*0.92),uTint2,0.3)*(0.55+0.8*uv.y);
    float cap=step(h,uv.y)*step(uv.y,h+0.03)*step(0.14,cx)*step(cx,0.86)*step(0.02,h);
    col+=(ec*on*1.3+vec3(1.,.86,.7)*cap*0.9)*uWM.y;
  }
  if(uWM.z>0.01||uWall.z>0.01){
    float d=length(q); float ang=atan(q.y,q.x);
    float rays=pow(abs(sin(ang*11.+uT*0.25)),10.)*(0.12+0.7*uWall.x)*exp(-d*1.6);
    col+=mix(uTint2,vec3(1.,.8,.6),0.25)*rays*uWM.z*1.2;
    col+=uTint*uWall.x*(0.35*exp(-d*d*5.))*uWM.z;
    for(int i=0;i<4;i++){ vec4 s=uShock[i]; if(s.y<=0.001) continue; float rr=s.x*1.1; float w=(d-rr)/0.05; col+=uShockC[i]*exp(-w*w)*s.y*(1.-s.x/1.6)*1.4*(0.4+0.6*uWM.z); }
    col+=GOLDC*uWall.z*(0.9*exp(-d*d*2.5)+rays*2.);
  }
  for(int i=0;i<8;i++){
    vec4 h=uHit[i]; if(h.w<0.5) continue;
    vec2 p=vec2(0.12+0.76*h.x,0.2+0.65*h.y); vec2 dd=(uv-p)*vec2(asp,1.); float dl=length(dd);
    float sz=0.045+h.z*0.1; float amp=exp(-h.z*1.5);
    float ring=exp(-pow((dl-h.z*0.32)/0.025,2.))*0.7;
    col+=uHitC[i]*(exp(-dl*dl/(sz*sz))*1.6+ring)*amp*uWM.w;
  }
  vec2 cell=fract(uv*vec2(190.,107.)); float dm=smoothstep(.52,.28,length(cell-.5));
  dm=mix(dm,.55,max(smoothstep(.2,.55,fp*190.),soft)); col*=0.12+0.88*dm; col=col/(1.+0.3*col);
  return col*0.9*uWall.y;
}
float gobo(vec2 ab,float id){
  float r=length(ab); float a=atan(ab.y,ab.x); float rot=uT*0.4;
  if(id<0.5) return 0.55+0.45*(1.-r);
  if(id<1.5) return 0.25+0.75*smoothstep(0.38,0.56,texture2D(uNoise,ab*0.55+vec2(0.5+uT*0.02,0.5)).g);
  if(id<2.5) return 0.2+0.8*smoothstep(0.06,-0.06,r-(0.3+0.65*pow(abs(cos(2.5*a+rot)),3.)));
  return 0.2+0.8*step(0.5,fract((ab.x*cos(rot)+ab.y*sin(rot))*3.2));
}
vec3 surfBeams(vec3 P,float isWall){
  vec3 acc=vec3(0.); if(uAbl.z>0.5) return acc;
  for(int b=0;b<${MAXL};b++){
    if(b>=uBN) break; vec4 bc=uBC[b]; if(bc.w<0.01) continue;
    vec4 ba=uBA[b], bd=uBD[b]; vec3 Q=P-ba.xyz; vec3 D=bd.xyz; float s=dot(Q,D); if(s<0.5) continue;
    float rr=s*ba.w; float u2=(dot(Q,Q)-s*s)/(rr*rr); if(u2>=1.) continue;
    vec3 U=normalize(abs(D.y)>0.95?cross(D,vec3(1.,0.,0.)):cross(D,vec3(0.,1.,0.))); vec3 V=cross(D,U);
    vec2 ab=vec2(dot(Q,U),dot(Q,V))/rr; float edge=1.-u2;
    float inc=isWall>0.5?max(-D.z,0.):max(-D.y,0.);
    acc+=bc.rgb*smoothstep(0.,0.2,edge)*gobo(ab,bd.w)*inc*3.2*clamp(0.07/ba.w,0.6,1.8)/(1.+s*s*0.004);
  }
  return acc;
}
/* ---- 雾里的光束:解析求光锥与视线的交,在交段里少量步进积分散射 ---- */
vec3 volume(vec3 O,vec3 R,float tMax,float nSteps,float jit){
  vec3 acc=vec3(0.); if(uAbl.w>0.5) return acc;
  for(int b=0;b<${MAXL};b++){
    if(b>=uBN) break; vec4 bc=uBC[b]; if(bc.w<0.01) continue;
    vec4 ba=uBA[b], bd=uBD[b]; vec3 A=ba.xyz, D=bd.xyz; float tn=ba.w; float c2=1./(1.+tn*tn);
    vec3 Wv=O-A; float a0=dot(Wv,D), b0=dot(R,D), WR=dot(Wv,R), WW=dot(Wv,Wv);
    float qa=b0*b0-c2, qb=a0*b0-c2*WR, qc=a0*a0-c2*WW; if(abs(qa)<1e-5) continue;
    float disc=qb*qb-qa*qc; if(disc<0.) continue;
    float sq=sqrt(disc); float ra=(-qb-sq)/qa, rb=(-qb+sq)/qa; if(ra>rb){ float tmp=ra; ra=rb; rb=tmp; }
    float t0,t1;
    if(qa<0.){ if(a0+0.5*(ra+rb)*b0<0.) continue; t0=ra; t1=rb; } else if(b0>0.){ t0=rb; t1=tMax; } else { t0=0.; t1=ra; }
    t0=max(t0,0.); t1=min(t1,tMax); if(t1<=t0) continue;
    float ns=clamp(floor((t1-t0)/2.0)+2.,3.,nSteps); float dt=(t1-t0)/ns; float g=0.55; float cosa=dot(D,-R);
    float ph=0.16+0.2*(1.-g*g)/pow(1.+g*g-2.*g*cosa,1.5);
    vec3 U=normalize(abs(D.y)>0.95?cross(D,vec3(1.,0.,0.)):cross(D,vec3(0.,1.,0.))); vec3 V=cross(D,U);
    float sum=0.;
    for(int k=0;k<16;k++){
      if(float(k)>=ns) break;
      vec3 p=O+R*(t0+(float(k)+jit)*dt); vec3 Q=p-A; float s=max(dot(Q,D),0.4);
      float rr=s*tn; float u2=(dot(Q,Q)-s*s)/(rr*rr); if(u2>=1.) continue;
      float edge=1.-u2; float prof=edge*edge*edge*(0.35+0.65*edge)+0.04*edge;
      vec2 ab=vec2(dot(Q,U),dot(Q,V))/rr;
      float strk=0.72+0.28*sin(ab.x*8.+ab.y*3.+s*0.07+uT*0.5);
      sum+=prof*strk*hazeAt(p)/(1.+s*s*0.0055);
    }
    float conc=clamp(0.0049/(tn*tn),0.5,3.);
    acc+=bc.rgb*sum*dt*ph*uGain*conc;
  }
  return acc;
}
vec3 wallCol(vec3 P,float fpm){
  vec2 uv=vec2((P.x+WALL_X)/(2.*WALL_X),(P.y-WALL_Y0)/(WALL_Y1-WALL_Y0));
  vec3 c=vec3(0.004,0.0035,0.0038);
  if(uv.x>0.&&uv.x<1.&&uv.y>0.&&uv.y<1.){
    float fr=smoothstep(0.,0.006,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)*2.));
    c=ledWall(uv,fpm/(WALL_Y1-WALL_Y0),0.)*fr+vec3(0.006,0.005,0.0055);
  }
  return c+surfBeams(P,1.)*0.6;
}
vec3 floorCol(vec3 P,vec3 R,float jit){
  vec3 f=vec3(0.010,0.0075,0.0085);
  float st=1.-smoothstep(-4.5,-2.0,P.z);
  f+=surfBeams(P,0.)*(0.5+0.5*st);
  float fres=0.04+0.96*pow(1.-clamp(-R.y,0.,1.),4.);
  float refl=(0.35+0.9*fres)*(0.3+0.7*st);
  vec3 Rr=vec3(R.x,-R.y,R.z); float n=texture2D(uNoise,P.xz*vec2(0.22,0.07)).b-0.5;
  float tw=max((WALL_Z-P.z)/min(Rr.z,-0.01),0.1); vec3 Pw=P+Rr*tw; Pw.x+=n*0.6;
  vec2 uv=vec2((Pw.x+WALL_X)/(2.*WALL_X),(Pw.y-WALL_Y0)/(WALL_Y1-WALL_Y0));
  if(uv.x>0.&&uv.x<1.&&uv.y>0.&&uv.y<1.) f+=ledWall(uv,0.03,1.)*refl*(0.8+0.6*n);
  if(uReflect>0.5&&st>0.02) f+=volume(P,Rr,tw,3.,jit)*refl*1.3;
  for(int i=0;i<4;i++){ vec4 s=uShock[i]; if(s.y<=0.001) continue; float rr=s.x*13.; float d=length(P.xz-vec2(0.,-9.))-rr; float ring=exp(-d*d*0.9)*(1.-s.x/1.6)*(1.-s.x/1.6); f+=uShockC[i]*(ring*s.y*0.9+exp(-s.x*6.)*s.y*0.12)*st; }
  float lip=exp(-abs(P.z+2.6)*1.6)*step(abs(P.x),11.)*uWall.y*(0.15+0.85*uWall.w);
  f+=mix(uTint,vec3(1.),0.2)*lip*0.3;
  return f;
}
float sdSeg(vec2 p,vec2 a,vec2 b){ vec2 pa=p-a,ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.); return length(pa-ba*h); }
vec2 crowdLayer(vec2 p,float w,float seed,float hgt,float px){
  float cell=floor(p.x/w); float m=0.; float rim=0.;
  for(int k=-1;k<=1;k++){
    float i=cell+float(k); float h1=hash12(vec2(i,seed)),h2=hash12(vec2(i,seed+7.)),h3=hash12(vec2(i,seed+13.)),h4=hash12(vec2(i,seed+29.));
    float cx=(i+0.25+0.5*h1)*w; float r=w*(0.17+0.05*h2);
    float hy=hgt+(h3-.5)*0.03+sin(uT*(1.6+h3*1.4)+i)*0.004*(0.4+uFx.z)+uBeat*0.006;
    float d=length(p-vec2(cx,hy))-r;
    vec2 sp=(p-vec2(cx,hy-r*2.0))/vec2(r*2.3,r*1.9); d=min(d,(length(sp)-1.)*r*1.9);
    if(h4<uFx.w*0.75){ float sg=h1>0.5?1.:-1.; float sw=sin(uT*(2.+h2*2.)+i*1.7)*r*0.9;
      vec2 a=vec2(cx+sg*r*1.7,hy-r*1.3); vec2 b=a+vec2(sg*r*0.9+sw*0.6,r*(2.4+1.5*h3));
      d=min(d,min(sdSeg(p,a,b)-r*0.26,length(p-b)-r*0.34)); }
    float mk=smoothstep(px,-px,d); m=max(m,mk);
  }
  m=max(m,step(p.y,hgt-0.055)); return vec2(m,rim);
}
void main(){
  vec2 ndc=vUv*2.-1.; float asp=uRes.x/uRes.y;
  vec3 R=normalize(uFwd+uRight*ndc.x*uTanH*asp+uUp*ndc.y*uTanH); vec3 O=uCam;
  float tw=1e9,tf=1e9; if(R.z<-1e-4) tw=(WALL_Z-O.z)/R.z; if(R.y<-1e-4) tf=-O.y/R.y;
  bool fl=tf<tw; float tS=min(min(tw,tf),70.); vec3 P=O+R*tS;
  float jit=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715)))+uT*3.7);
  float fpm=tS*2.*uTanH/uRes.y;
  vec3 col=fl?floorCol(P,R,jit):wallCol(P,fpm);
  col*=exp(-0.012*uHazeD*tS);
  col+=volume(O,R,tS,uSteps,jit);
  float amb=1.-exp(-0.018*uHazeD*tS); vec3 mid=O+R*tS*0.7; float nw=smoothstep(-2.,-16.,mid.z);
  col+=uHaze*amb*(0.5+0.4*clamp(R.y*2.+.6,0.,1.))*0.5+uTint*uWall.y*(0.1+0.5*uWall.w)*amb*nw*0.2;
  if(vUv.y<0.36&&uCrowdL>0.5&&uAbl.y<0.5){
    float px=1.3/uRes.y;
    float sh=uCam.x*0.012; vec2 pp=vec2(vUv.x*asp,vUv.y);
    vec2 c1=crowdLayer(pp+vec2(sh*0.4,0.),0.075,3.,0.095,px); col=mix(col,uHaze*0.25+0.002,c1.x*0.9);
    if(uCrowdL>1.5){ vec2 c2=crowdLayer(pp+vec2(sh,0.),0.12,17.,0.06,px); col=mix(col,uHaze*0.1+0.0015,c2.x); }
    if(uCrowdL>2.5){ vec2 c3=crowdLayer(pp+vec2(sh*2.2,0.),0.2,41.,0.02,px); col=mix(col,vec3(0.0012),c3.x); }
  }
  col+=vec3(1.,.9,.78)*uFx.x*(0.25+0.5*amb)*(1.-0.5*vUv.y);
  col*=(1.-uFx.y);
  gl_FragColor=vec4(col,1.);
}`;
  }
  const FULL_VS = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }";
  const FLARE_FS = `
uniform vec2 uRes; uniform vec4 uLS[${MAXL}]; uniform vec4 uBC[${MAXL}]; uniform int uBN; uniform float uBeat;
varying vec2 vUv;
void main(){
  vec3 acc=vec3(0.); float asp=uRes.x/uRes.y;
  for(int b=0;b<${MAXL};b++){
    if(b>=uBN) break; vec4 ls=uLS[b]; if(ls.z<=0.001) continue; vec4 bc=uBC[b];
    vec2 d=(vUv-ls.xy)*vec2(asp,1.); float r=length(d);
    float core=ls.w*0.0016/(r*r+0.0003); float halo=exp(-r*16.)*0.1;
    float streak=exp(-abs(d.y)*110.)*exp(-abs(d.x)*4.)*0.3*(0.6+0.8*uBeat);
    vec2 g=(vec2(0.5,0.5)-ls.xy)*0.9; vec2 gd=(vUv-(ls.xy+g))*vec2(asp,1.); float ghost=smoothstep(0.045,0.03,length(gd))*0.05;
    acc+=bc.rgb*(core+halo+streak+ghost)*ls.z;
  }
  gl_FragColor=vec4(acc,1.);
}`;
  const DOWN_FS = "uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThresh; varying vec2 vUv; void main(){ vec3 a=texture2D(tSrc,vUv+uTexel*vec2(-1.,-1.)).rgb,b=texture2D(tSrc,vUv+uTexel*vec2(1.,-1.)).rgb,c=texture2D(tSrc,vUv+uTexel*vec2(-1.,1.)).rgb,d=texture2D(tSrc,vUv+uTexel*vec2(1.,1.)).rgb; vec3 s=(a+b+c+d)*0.25; if(uThresh>0.){ float l=max(s.r,max(s.g,s.b)); s*=clamp((l-uThresh)/(l+0.001),0.,1.); s=min(s,vec3(6.)); } gl_FragColor=vec4(s,1.); }";
  const UP_FS = "uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uK; varying vec2 vUv; void main(){ vec3 s=texture2D(tSrc,vUv+uTexel*vec2(-1.,-1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(1.,-1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(-1.,1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(1.,1.)).rgb; s+=2.*(texture2D(tSrc,vUv+uTexel*vec2(0.,-1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(0.,1.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(-1.,0.)).rgb+texture2D(tSrc,vUv+uTexel*vec2(1.,0.)).rgb); s+=4.*texture2D(tSrc,vUv).rgb; gl_FragColor=vec4(s*(1./16.)*uK,1.); }";
  const COMP_FS = `uniform sampler2D tScene, tBloom; uniform vec2 uRes; uniform float uBloom, uExp, uT, uKick, uPre, uBlack, uLift;
varying vec2 vUv;
${NOISE_GLSL}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.,1.); }
void main(){
  vec2 uv=(vUv-.5)*(1.-0.012*uKick)+.5;   // 底鼓时画面轻轻"一顿"(径向缩放);不做色散——红蓝错位会在亮边上产生青色,违反青绿独占
  vec3 c=texture2D(tScene,uv).rgb/uPre;
  c+=texture2D(tBloom,uv).rgb*uBloom/uPre;
  c*=uExp; c=aces(c);
  float l=dot(c,vec3(.2126,.7152,.0722)); c+=vec3(0.022,0.005,0.016)*uLift*(1.-smoothstep(0.,0.22,l));
  c=pow(c,vec3(1./2.2));
  float asp=uRes.x/uRes.y; float v=length((uv-.5)*vec2(asp*0.75,1.)); c*=mix(1.,smoothstep(1.0,0.28,v),0.75);
  c+=(hash12(uv*uRes+fract(uT)*91.)-0.5)*0.022;
  gl_FragColor=vec4(c*(1.-uBlack),1.);   // uBlack:静默(blackout)——整帧压到真黑,含暗部分级抬升、暗角与胶片颗粒
}`;
  const PART_VS = "attribute vec4 aCol; attribute float aSize; attribute float aRot; varying vec4 vCol; varying float vRot; uniform float uScale; void main(){ vCol=aCol; vRot=aRot; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; gl_PointSize=max(aSize*uScale/(-mv.z),0.); }";
  const SPARK_FS = "varying vec4 vCol; void main(){ vec2 p=gl_PointCoord-.5; float d=length(p)*2.; float a=exp(-d*d*3.5)*vCol.a; if(a<0.004) discard; gl_FragColor=vec4(vCol.rgb*a,1.); }";
  const CONF_FS = "varying vec4 vCol; varying float vRot; void main(){ vec2 p=gl_PointCoord-.5; float c=cos(vRot),s=sin(vRot); p=vec2(c*p.x-s*p.y,s*p.x+c*p.y); float flip=abs(cos(vRot*1.7)); float m=step(abs(p.x),0.3)*step(abs(p.y),0.12+0.1*flip); if(m<0.5||vCol.a<0.01) discard; gl_FragColor=vec4(vCol.rgb*vCol.a*(0.55+0.5*flip),1.); }";
  const SIL_VS = "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }";
  const SIL_FS = `uniform sampler2D tMask; uniform vec2 uTexel; uniform vec3 uRim, uLit, uHaze; uniform float uLitAmt, uPlayer, uBright;
varying vec2 vUv;
void main(){
  vec4 m=texture2D(tMask,vUv); float inst=m.r, pl=m.b*uPlayer, a=max(inst,pl);
  if(a<0.01&&m.g<0.01) discard;
  vec4 mx=texture2D(tMask,vUv+vec2(uTexel.x*1.5,0.)),mn=texture2D(tMask,vUv-vec2(uTexel.x*1.5,0.)),my=texture2D(tMask,vUv+vec2(0.,uTexel.y*2.));
  float cur=max(m.r,m.b*uPlayer); float up=max(my.r,my.b*uPlayer); float sd=(max(mx.r,mx.b*uPlayer)+max(mn.r,mn.b*uPlayer))*0.5;
  float rim=clamp((cur-up)*1.6+(cur-sd)*0.25,0.,1.);
  vec3 c=uHaze*0.35+uRim*rim*uBright+uLit*m.g*uLitAmt*(0.55+0.45*(1.-length(vUv-vec2(0.5)))) ;
  gl_FragColor=vec4(c,max(a,m.g*uLitAmt));
}`;

  /* ---------- 工具:噪声纹理、剪影纹理 ---------- */
  function makeNoise() {
    const N = 256, d = new Uint8Array(N * N * 4);
    const lat = (n, seed) => { const a = new Float32Array(n * n); let s = seed >>> 0; for (let i = 0; i < a.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s / 4294967296; } return a; };
    const samp = (a, n, x, y) => { x *= n; y *= n; const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); const g = (i, j) => a[(((j % n) + n) % n) * n + (((i % n) + n) % n)]; return (g(xi, yi) * (1 - u) + g(xi + 1, yi) * u) * (1 - v) + (g(xi, yi + 1) * (1 - u) + g(xi + 1, yi + 1) * u) * v; };
    for (let ch = 0; ch < 3; ch++) {
      const octs = [[4, 0.45], [8, 0.3], [16, 0.17], [32, 0.08]].map(([n, w], i) => [lat(n, 1234 + ch * 97 + i * 31), n, w]);
      const v = new Float32Array(N * N); let mn = 9, mx = -9;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; octs.forEach(([a, n, w]) => (s += samp(a, n, x / N, y / N) * w)); v[y * N + x] = s; mn = Math.min(mn, s); mx = Math.max(mx, s); }
      for (let i = 0; i < N * N; i++) d[i * 4 + ch] = Math.round(((v[i] - mn) / (mx - mn)) * 255);
    }
    for (let i = 0; i < N * N; i++) d[i * 4 + 3] = 255;
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    return t;
  }
  function silTexture(w, h, inst, lit, player) {   // R=乐器与架子 G=发光部分 B=演奏者;用 2D 画布画矢量剪影再打包
    const layer = (fn) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.fillStyle = x.strokeStyle = "#fff"; x.lineCap = x.lineJoin = "round"; if (fn) fn(x); return x.getImageData(0, 0, w, h).data; };
    const a = layer(inst), b = layer(lit), p = layer(player), d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4; d[o] = a[s + 3]; d[o + 1] = b[s + 3]; d[o + 2] = p[s + 3]; d[o + 3] = 255; }
    const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return t;
  }
  const ell = (x, cx, cy, rx, ry, rot) => { x.beginPath(); x.ellipse(cx, cy, rx, ry, rot || 0, 0, 7); x.fill(); };
  const line = (x, ax, ay, bx, by, w) => { x.lineWidth = w; x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke(); };
  function drawDrums() {
    return silTexture(640, 448, (x) => {
      ell(x, 320, 355, 92, 88); ell(x, 258, 245, 52, 46); ell(x, 384, 245, 52, 46); ell(x, 505, 335, 64, 58); ell(x, 130, 322, 52, 22);
      line(x, 130, 330, 130, 440, 7); line(x, 505, 390, 505, 440, 8); line(x, 320, 440, 320, 445, 6);
      ell(x, 62, 232, 54, 7, -0.08); line(x, 62, 238, 62, 440, 5); ell(x, 170, 150, 66, 8, -0.2); line(x, 170, 158, 170, 330, 5); ell(x, 500, 170, 72, 8, 0.15); line(x, 500, 178, 500, 330, 5);
      ell(x, 320, 300, 42, 8); line(x, 320, 300, 320, 340, 8);
    }, (x) => { ell(x, 320, 355, 76, 72); ell(x, 258, 245, 40, 34); ell(x, 384, 245, 40, 34); ell(x, 505, 335, 50, 44); ell(x, 130, 322, 40, 15); },
    (x) => { ell(x, 320, 300, 40, 8); x.beginPath(); x.moveTo(284, 300); x.lineTo(290, 214); x.quadraticCurveTo(320, 196, 350, 214); x.lineTo(356, 300); x.fill(); ell(x, 320, 178, 27, 31); line(x, 290, 222, 232, 258, 17); line(x, 232, 258, 196, 196, 9); line(x, 350, 222, 408, 262, 17); line(x, 408, 262, 450, 205, 9); });
  }
  function drawBass() {
    return silTexture(256, 512, (x) => { ell(x, 52, 440, 40, 50); x.fillRect(14, 395, 76, 100); }, (x) => { ell(x, 52, 445, 26, 30); },
    (x) => { ell(x, 140, 78, 26, 29); x.beginPath(); x.moveTo(104, 112); x.lineTo(176, 112); x.lineTo(168, 282); x.lineTo(112, 282); x.closePath(); x.fill(); line(x, 126, 280, 118, 492, 22); line(x, 156, 280, 164, 492, 22); line(x, 116, 150, 108, 262, 14); line(x, 170, 140, 206, 190, 14);
      x.save(); x.translate(130, 230); x.rotate(-0.42); x.fillRect(-12, -18, 130, 34); ell(x, -12, 0, 34, 26); x.fillRect(110, -9, 78, 15); x.restore(); });
  }
  function drawKeys() {
    return silTexture(384, 384, (x) => { x.beginPath(); x.moveTo(34, 238); x.lineTo(350, 238); x.lineTo(344, 258); x.lineTo(40, 258); x.fill(); line(x, 90, 258, 70, 374, 8); line(x, 294, 258, 314, 374, 8); },
      (x) => { x.fillRect(46, 232, 292, 8); },
    (x) => { ell(x, 192, 92, 26, 29); x.beginPath(); x.moveTo(150, 126); x.lineTo(234, 126); x.lineTo(228, 262); x.lineTo(156, 262); x.fill(); line(x, 156, 150, 120, 232, 15); line(x, 228, 150, 262, 232, 15); });
  }

  /* ---------- 初始化 ---------- */
  S.init = function (cont, opts) {
    container = cont; Object.assign(S.opts, opts || {});
    let probe = document.createElement("canvas");
    try { if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) throw new Error("本机浏览器没有可用的 WebGL"); } catch (e) { S.reason = String(e.message || e); return initFallback(); }
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: S.opts.gpuPref || "default", preserveDrawingBuffer: !!S.opts.capture });
    } catch (e) { S.reason = String(e.message || e); return initFallback(); }
    try {
      gl = renderer.getContext(); const ex = gl.getExtension("WEBGL_debug_renderer_info"); S.gpu = ex ? String(gl.getParameter(ex.UNMASKED_RENDERER_WEBGL)) : "unknown";
    } catch (e) { S.gpu = "unknown"; }
    if (/SwiftShader|llvmpipe|Software|Basic Render/i.test(S.gpu) && !S.opts.forceGL) { S.reason = "没有显卡加速(软件渲染)"; try { renderer.dispose(); } catch (x) { /* 忽略 */ } renderer = null; return initFallback(); }
    try { build(); } catch (e) { S.reason = "着色器/场景构建失败:" + (e && e.message || e); console.warn(S.reason); try { renderer.dispose(); } catch (x) { /* 忽略 */ } container.innerHTML = ""; renderer = null; return initFallback(); }
    S.mode = "webgl"; S.ok = true; return S;
  };

  function build() {
    dir = S.dir = Dir.create({ Core }); rig = dir.rig;
    canvas = renderer.domElement; canvas.className = "stage-canvas"; canvas.setAttribute("aria-label", "虚拟舞台:你在 Launchpad 上弹的每一个音,都在指挥这里的灯"); container.appendChild(canvas);
    renderer.autoClear = false; renderer.setPixelRatio(1);
    const ext = (n) => !!gl.getExtension(n);
    hdr = renderer.capabilities.isWebGL2 ? (ext("EXT_color_buffer_float") || ext("EXT_color_buffer_half_float")) : false;
    S.hdr = hdr;
    Q.tier = WEAK.test(S.gpu) ? "mid" : "high";
    camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200); ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    noiseTex = makeNoise();
    bandData = new Uint8Array(16 * 4); bandTex = new THREE.DataTexture(bandData, 16, 1, THREE.RGBAFormat); bandTex.magFilter = bandTex.minFilter = THREE.LinearFilter; bandTex.generateMipmaps = false; bandTex.needsUpdate = true;
    const V4 = (n) => Array.from({ length: n }, () => new THREE.Vector4()), V3 = (n) => Array.from({ length: n }, () => new THREE.Vector3());
    const quad = (mat) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); m.frustumCulled = false; return m; };
    const ramp = dir.RAMP.map((c) => lin3(c)), gold = lin3(dir.GOLD);
    stageMat = new THREE.ShaderMaterial({
      vertexShader: FULL_VS, fragmentShader: stageFS(ramp, gold), depthTest: false, depthWrite: false,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uCam: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
        uTanH: { value: 0.35 }, uT: { value: 0 }, uBN: { value: 14 }, uSteps: { value: 12 }, uReflect: { value: 1 }, uCrowdL: { value: 3 }, uHq: { value: 1 }, uGain: { value: 4.0 }, uAbl: { value: new THREE.Vector4() },
        uBA: { value: V4(MAXL) }, uBD: { value: V4(MAXL) }, uBC: { value: V4(MAXL) }, uNoise: { value: noiseTex }, uBands: { value: bandTex },
        uWM: { value: new THREE.Vector4() }, uWall: { value: new THREE.Vector4() }, uFx: { value: new THREE.Vector4() },
        uTint: { value: new THREE.Vector3() }, uTint2: { value: new THREE.Vector3() }, uHaze: { value: new THREE.Vector3() }, uHazeD: { value: 0.5 }, uBeat: { value: 0 },
        uHit: { value: V4(8) }, uHitC: { value: V3(8) }, uShock: { value: V4(4) }, uShockC: { value: V3(4) },
      },
    });
    sceneStage = new THREE.Scene(); sceneStage.add(quad(stageMat));
    flareMat = new THREE.ShaderMaterial({ vertexShader: FULL_VS, fragmentShader: FLARE_FS, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
      uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uLS: { value: V4(MAXL) }, uBC: stageMat.uniforms.uBC, uBN: stageMat.uniforms.uBN, uBeat: stageMat.uniforms.uBeat } });
    sceneFlare = new THREE.Scene(); sceneFlare.add(quad(flareMat));
    downMat = new THREE.ShaderMaterial({ vertexShader: FULL_VS, fragmentShader: DOWN_FS, depthTest: false, depthWrite: false, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThresh: { value: 0 } } });
    upMat = new THREE.ShaderMaterial({ vertexShader: FULL_VS, fragmentShader: UP_FS, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uK: { value: 1 } } });
    sceneBlit = { down: new THREE.Scene(), up: new THREE.Scene() }; sceneBlit.down.add(quad(downMat)); sceneBlit.up.add(quad(upMat));
    compMat = new THREE.ShaderMaterial({ vertexShader: FULL_VS, fragmentShader: COMP_FS, depthTest: false, depthWrite: false, uniforms: { tScene: { value: null }, tBloom: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uBloom: { value: 0.5 }, uExp: { value: 1 }, uT: { value: 0 }, uKick: { value: 0 }, uPre: { value: 1 }, uBlack: { value: 0 }, uLift: { value: 1 } } });
    sceneComp = new THREE.Scene(); sceneComp.add(quad(compMat));
    buildWorld();
    // 引导:包一层 Core.press / Core.on("finish"),把按键与完成事件交给导演
    const orig = Core.press;
    Core.press = (id, down) => { orig(id, down); if (down && id < 100 && id % 10 >= 1 && id % 10 <= 8 && !(Core.hw && Core.hw.active)) dir.hit(id, 0, performance.now() / 1000); };
    Core.on("finish", () => dir.celebrate(performance.now() / 1000)); Core.on("hwFinish", () => dir.celebrate(performance.now() / 1000));
    new ResizeObserver(() => S.resize()).observe(container);
    S.resize();
  }

  function buildWorld() {
    sceneWorld = new THREE.Scene();
    const black = new THREE.MeshBasicMaterial({ color: 0x050404, depthTest: false, depthWrite: false });
    const rimMat = new THREE.LineBasicMaterial({ color: 0x1a120e, depthTest: false, transparent: true, opacity: 0.7 });
    const truss = (y, z, x0, x1) => {   // 桁架:上下弦 + 斜撑,黑色 + 一圈极暗的暖色边线,安静时也能看见"灯架在那儿"
      const g = new THREE.Group(), n = 28, pts = [];
      [[0.45, 0.45], [-0.45, 0.45], [0.45, -0.45], [-0.45, -0.45]].forEach(([dy, dz]) => { pts.push(x0, y + dy, z + dz, x1, y + dy, z + dz); });
      for (let i = 0; i < n; i++) { const x = x0 + ((x1 - x0) * i) / n, xn = x0 + ((x1 - x0) * (i + 1)) / n; pts.push(x, y + 0.45, z, xn, y - 0.45, z, x, y - 0.45, z, xn, y + 0.45, z); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const ls = new THREE.LineSegments(geo, rimMat); ls.renderOrder = 2; g.add(ls);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.1, 0.1), black); bar.position.set((x0 + x1) / 2, y + 0.5, z); bar.renderOrder = 2; g.add(bar);
      return g;
    };
    sceneWorld.add(truss(8.6 + 0.55, -8, -10.5, 10.5)); sceneWorld.add(truss(9.8 + 0.55, -14.5, -9, 9));
    const bodyGeo = new THREE.CylinderGeometry(0.26, 0.2, 0.75, 14); bodyGeo.translate(0, 0.375, 0);
    for (let i = 0; i < MAXL; i++) { const m = new THREE.Mesh(bodyGeo, black); m.renderOrder = 3; sceneWorld.add(m); lampBodies.push(m); }
    const mk = (tex, w, h, x, y, z) => {
      const mat = new THREE.ShaderMaterial({ vertexShader: SIL_VS, fragmentShader: SIL_FS, transparent: true, depthTest: false, depthWrite: false,
        uniforms: { tMask: { value: tex }, uTexel: { value: new THREE.Vector2(1 / tex.image.width, 1 / tex.image.height) }, uRim: { value: new THREE.Vector3() }, uLit: { value: new THREE.Vector3() }, uHaze: { value: new THREE.Vector3() }, uLitAmt: { value: 0 }, uPlayer: { value: 0 }, uBright: { value: 1 } } });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.renderOrder = 4; sceneWorld.add(m); return { m, mat };
    };
    silh.drum = mk(drawDrums(), 5.6, 3.92, 0, 1.96, -12.6); silh.bass = mk(drawBass(), 1.8, 3.6, -3.9, 1.8, -10.6); silh.keys = mk(drawKeys(), 3.6, 3.6, 4.6, 1.8, -10.6);
    particles.sparks = makeParticles(280, false); particles.conf = makeParticles(220, true);
  }
  function makeParticles(n, conf) {
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(n * 3).fill(-999), col = new Float32Array(n * 4), siz = new Float32Array(n), rot = new Float32Array(n);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); geo.setAttribute("aCol", new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(siz, 1)); geo.setAttribute("aRot", new THREE.BufferAttribute(rot, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({ vertexShader: PART_VS, fragmentShader: conf ? CONF_FS : SPARK_FS, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, uniforms: { uScale: { value: 500 } } });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 6; sceneWorld.add(pts);
    return { n, pts, geo, mat, pos, col, siz, rot, vel: new Float32Array(n * 3), base: new Float32Array(n * 3), age: new Float32Array(n).fill(9), life: new Float32Array(n).fill(1), cur: 0, conf };
  }
  function spawn(P, x, y, z, vx, vy, vz, c, life, size) {
    const i = P.cur++ % P.n; P.pos[i * 3] = x; P.pos[i * 3 + 1] = y; P.pos[i * 3 + 2] = z; P.vel[i * 3] = vx; P.vel[i * 3 + 1] = vy; P.vel[i * 3 + 2] = vz;
    P.base[i * 3] = lin(c[0]); P.base[i * 3 + 1] = lin(c[1]); P.base[i * 3 + 2] = lin(c[2]); P.age[i] = 0; P.life[i] = life; P.siz[i] = size; P.rot[i] = Math.random() * 6.28;
  }
  function stepParticles(P, dt, t, gain) {
    let any = false;
    for (let i = 0; i < P.n; i++) {
      if (P.age[i] >= P.life[i]) { if (P.col[i * 4 + 3] !== 0) { P.col[i * 4 + 3] = 0; any = true; } continue; }
      P.age[i] += dt; const f = 1 - P.age[i] / P.life[i];
      if (P.conf) {
        P.vel[i * 3] += Math.sin(t * 2 + i) * dt * 2.4; P.vel[i * 3 + 1] = Math.max(P.vel[i * 3 + 1] - 3 * dt, -2.0); P.rot[i] += dt * (2 + (i % 5));
        P.col[i * 4 + 3] = Math.min(1, f * 3) * Math.min(1, P.age[i] * 4);
      } else { P.vel[i * 3 + 1] -= 6.5 * dt; const k = Math.exp(-0.9 * dt); P.vel[i * 3] *= k; P.vel[i * 3 + 2] *= k; P.col[i * 4 + 3] = f * f * 2.6; }
      P.pos[i * 3] += P.vel[i * 3] * dt; P.pos[i * 3 + 1] += P.vel[i * 3 + 1] * dt; P.pos[i * 3 + 2] += P.vel[i * 3 + 2] * dt;
      P.col[i * 4] = P.base[i * 3] * gain; P.col[i * 4 + 1] = P.base[i * 3 + 1] * gain; P.col[i * 4 + 2] = P.base[i * 3 + 2] * gain; any = true;
      if (P.pos[i * 3 + 1] < 0.05 && P.vel[i * 3 + 1] < 0) P.age[i] = P.life[i];
    }
    if (any) { P.geo.attributes.position.needsUpdate = true; P.geo.attributes.aCol.needsUpdate = true; if (P.conf) P.geo.attributes.aRot.needsUpdate = true; }
  }

  /* ---------- 尺寸 / 画质 ---------- */
  function applyTier() {
    const t = S.opts.quality === "auto" ? Q.tier : S.opts.quality === "low" ? "low" : S.opts.quality === "mid" ? "mid" : "high";
    Q.eff = t;
    Q.steps = t === "high" ? 12 : t === "mid" ? 6 : 4; Q.bn = t === "high" ? 14 : t === "mid" ? 10 : 8; Q.bloom = t !== "low"; Q.reflect = t === "high"; Q.crowdL = t === "high" ? 3 : t === "mid" ? 2 : 1;
    Q.pixCap = t === "high" ? 1.6e6 : t === "mid" ? 0.55e6 : 0.4e6;
  }
  function allocTargets() {
    const sc = Math.min(1, Math.sqrt(Q.pixCap / (W * H))) * Q.dyn, w = Math.max(64, Math.round(W * sc)), h = Math.max(36, Math.round(H * sc));
    if (rtScene && rtScene.width === w && rtScene.height === h && rtScene.__bloom === Q.bloom) return;
    if (rtScene) { rtScene.dispose(); bloomRT.forEach((r) => r.dispose()); }
    const opt = { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };
    rtScene = new THREE.WebGLRenderTarget(w, h, opt); rtScene.__bloom = Q.bloom; bloomRT = [];
    if (Q.bloom) for (let i = 2; i <= 5; i++) bloomRT.push(new THREE.WebGLRenderTarget(Math.max(2, w >> i), Math.max(2, h >> i), opt));
    stageMat.uniforms.uRes.value.set(w, h); Q.rw = w; Q.rh = h;
  }
  S.resize = function () {
    if (!renderer) { if (fallback) fallback.resize(); return; }
    const r = container.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = Math.max(2, Math.round(r.width * dpr)); H = Math.max(2, Math.round(r.height * dpr));
    renderer.setSize(W, H, false); canvas.style.width = r.width + "px"; canvas.style.height = r.height + "px";
    camera.aspect = W / H; camera.updateProjectionMatrix(); compMat.uniforms.uRes.value.set(W, H); flareMat.uniforms.uRes.value.set(W, H);
    applyTier(); allocTargets();
    const sc = H / (2 * Math.tan((camera.fov * Math.PI) / 360)); particles.sparks.mat.uniforms.uScale.value = sc; particles.conf.mat.uniforms.uScale.value = sc;
  };
  S.setOptions = function (o) { Object.assign(S.opts, o); if (o.quality) { Q.tier = WEAK.test(S.gpu) ? "mid" : "high"; Q.dyn = 1; Q.noUpUntil = 0; if (renderer) { applyTier(); allocTargets(); } } };
  S.effQuality = () => Q.eff || Q.tier;

  /* ---------- 每帧 ---------- */
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
  function directorInputs(dt, t) {
    const info = A.currentInfo(), hw = Core.hw && Core.hw.active ? Core.hw.drive() : null;   // 跟打模式:能量/和弦/鼓贝斯状态来自命中与谱面,舞台不再"安静"
    return { level: A.level(), bands: A.spectrum(), bandOn: hw ? hw.bandOn : A.bandOn, drumsOn: hw ? hw.drumsOn : A.drumsOn, chordIdx: hw ? hw.chordIdx : info.idx || 0, bar: hw ? hw.bar : info.bar || 0, quiet: hw ? false : Core.quiet(), reduced: !!S.opts.reduced, styleMode: S.opts.styleMode, perf: !!S.opts.perf, bpm: hw ? hw.bpm : A.getBpm(), tonic: Core.tonic, hw };
  }
  function drive(dt, t) {
    A.drainEvents((ev) => dir.audioEvent(ev));
    const r = dir.update(dt, t, directorInputs(dt, t));
    // 灯光事件流(家庭灯占位订阅):同一份 rig 的抽象 3 区
    const d8 = (c) => c.map((v) => Math.round(clamp(v, 0, 1) * 255)), lastHit = r.wall.hits.length ? r.wall.hits[r.wall.hits.length - 1] : null;
    S.bus = { t, quiet: r.quiet, chord: ["I", "IV", "V", "vi"][r.chordIdx], style: r.styleName, energy: r.energy, section: r.section, zones: {
      wash: d8((lastHit ? lastHit.col : r.tint).map((v) => v * (lastHit ? Math.exp(-lastHit.age * 1.5) : 0.15))),
      strip: r.quiet ? d8(Core.cue(t).map((v) => Math.min(1, Math.pow(v / 63, 0.55)))) : d8(r.tint.map((v) => v * (0.25 + r.wall.level * 0.9))),
      accent: d8(dir.DRUM.map((v) => v * (0.1 + r.fx.kick * 0.9))) }, events: [] };
    for (const f of S.busListeners) f(S.bus);
    return r;
  }
  function pushUniforms(r, t) {
    const U = stageMat.uniforms, cam = r.cam;
    const asp = W / H, comp = asp < 1.75 ? Math.min(1.7, Math.pow(1.75 / asp, 0.8)) : 1;   // 窗口变窄(抽屉打开、竖屏)时机位后撤,保证整个舞台还在画面里
    camera.position.set(cam.target[0] + (cam.pos[0] - cam.target[0]) * comp, cam.target[1] + (cam.pos[1] - cam.target[1]) * comp, cam.target[2] + (cam.pos[2] - cam.target[2]) * comp); camera.fov = cam.fov; camera.lookAt(cam.target[0], cam.target[1], cam.target[2]); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    U.uCam.value.copy(camera.position); U.uRight.value.set(e[0], e[1], e[2]); U.uUp.value.set(e[4], e[5], e[6]); U.uFwd.value.set(-e[8], -e[9], -e[10]); U.uTanH.value = Math.tan((cam.fov * Math.PI) / 360);
    U.uT.value = t % 1000; U.uBN.value = Q.bn; U.uSteps.value = Q.steps; U.uReflect.value = Q.reflect ? 1 : 0; U.uCrowdL.value = Q.crowdL; U.uHq.value = Q.eff === "high" ? 1 : 0;
    const LS = flareMat.uniforms.uLS.value;
    for (let i = 0; i < MAXL; i++) {
      const L = r.lamps[i], on = L.inten > 0.003 && i < Q.bn;
      U.uBA.value[i].set(L.pos[0], L.pos[1], L.pos[2], L.tan);
      U.uBD.value[i].set(L.dir[0], L.dir[1], L.dir[2], L.gobo);
      const c = lin3(L.col, on ? L.inten : 0); U.uBC.value[i].set(c[0], c[1], c[2], on ? L.inten : 0);
      lampBodies[i].visible = i < Q.bn; lampBodies[i].position.set(L.pos[0], L.pos[1], L.pos[2]); _d.set(L.dir[0], L.dir[1], L.dir[2]); lampBodies[i].quaternion.setFromUnitVectors(_up, _d);
      _v.set(L.pos[0] + L.dir[0] * 0.95, L.pos[1] + L.dir[1] * 0.95, L.pos[2] + L.dir[2] * 0.95).project(camera);
      const vis = _v.z < 1 && _v.z > -1 && Math.abs(_v.x) < 1.6 && Math.abs(_v.y) < 1.6 && on ? 1 : 0;
      LS[i].set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5, vis * L.inten, i >= 12 ? 0.5 : 1);
      _v.set(L.pos[0], L.pos[1] - 0.3, L.pos[2]).project(camera); S.lampPx[i] = [_v.x * 0.5 + 0.5, 0.5 - _v.y * 0.5];   // 灯体在画面里的位置(0~1),跟打的追光锥从这里出发
    }
    flareMat.uniforms.uBN.value = Q.bn;
    const W_ = r.wall; U.uWM.value.set(W_.mode[0], W_.mode[1], W_.mode[2], W_.mode[3]);
    U.uWall.value.set(W_.kick, W_.dim, W_.gold, W_.level);
    const tt = lin3(W_.tint), t2 = lin3(W_.tint2), hz = lin3(r.haze.col);
    U.uTint.value.set(tt[0], tt[1], tt[2]); U.uTint2.value.set(t2[0], t2[1], t2[2]); U.uHaze.value.set(hz[0], hz[1], hz[2]); U.uHazeD.value = r.haze.density * (Q.eff === "low" ? 0.8 : 1);
    U.uFx.value.set(r.fx.flash, r.fx.blackout, r.fx.crowd, r.fx.hands); U.uBeat.value = r.fx.kick;
    for (let i = 0; i < 8; i++) { const h = W_.hits[W_.hits.length - 1 - i]; if (h) { U.uHit.value[i].set(h.x, h.y, h.age, 1); const c = lin3(h.col); U.uHitC.value[i].set(c[0], c[1], c[2]); } else U.uHit.value[i].set(0, 0, 0, 0); }
    for (let i = 0; i < 4; i++) { const s = r.fx.shocks[i]; if (s) { U.uShock.value[i].set(s.age, s.amp, 0, 0); const c = lin3(s.col); U.uShockC.value[i].set(c[0], c[1], c[2]); } else U.uShock.value[i].set(0, 0, 0, 0); }
    for (let b = 0; b < 16; b++) bandData[b * 4] = Math.round(clamp(W_.bands[b], 0, 1) * 255); bandTex.needsUpdate = true;
    // 乐队剪影
    const rimBase = lin3(W_.tint, (0.35 + W_.level * 2.2) * W_.dim * 1.6), P = r.perf, hzc = [hz[0], hz[1], hz[2]];
    const setSil = (o, e, lit, litAmt, pl) => { const u = o.mat.uniforms; u.uRim.value.set(rimBase[0], rimBase[1], rimBase[2]); u.uHaze.value.set(hzc[0], hzc[1], hzc[2]); u.uLit.value.set(lit[0], lit[1], lit[2]); u.uLitAmt.value = litAmt; u.uPlayer.value = pl; u.uBright.value = 0.6 + 0.8 * e; };
    const dr = lin3(dir.DRUM, 0.7), ch = lin3(dir.CHORD[r.chordIdx], 0.8);
    setSil(silh.drum, P.drum.e, dr, 0.012 + P.drum.e * (0.12 + 1.5 * Math.max(P.drum.k, P.drum.h * 0.4)) * Math.max(0.3, W_.dim), P.drum.e);
    setSil(silh.bass, P.bass.e, ch, 0.01 + P.bass.e * (0.12 + 1.2 * P.bass.v) * Math.max(0.3, W_.dim), P.bass.e);
    setSil(silh.keys, P.keys.e, ch, 0.01 + P.keys.e * (0.12 + 1.2 * P.keys.pulse) * Math.max(0.3, W_.dim), P.keys.e);
    const bob = (o, y0, a) => { o.m.position.y = y0 + a; };
    bob(silh.drum, 1.96, P.drum.k * 0.05 * (S.opts.reduced ? 0.3 : 1)); bob(silh.bass, 1.8, Math.sin(t * 2.2) * 0.03 * P.bass.e + P.bass.v * 0.04); bob(silh.keys, 1.8, P.keys.pulse * 0.03);
    // 后期
    const c = compMat.uniforms; c.uBloom.value = Q.bloom ? r.fx.bloom * 0.42 : 0; c.uExp.value = 1.05; c.uT.value = t; c.uKick.value = S.opts.reduced ? 0 : r.fx.kick; c.uPre.value = hdr ? 1 : 0.4; c.uBlack.value = Math.min(1, r.fx.blackout || 0); c.uLift.value = r.fx.lift == null ? 1 : r.fx.lift;
  }
  function drawParticles(r, dt, t) {
    const red = !!S.opts.reduced, low = Q.eff === "low";
    r.spawn.forEach((e) => {
      if (low) return;
      if (e.kind === "spark" && !red) for (let k = 0; k < e.n * 3; k++) spawn(particles.sparks, e.pos[0], e.pos[1], e.pos[2], e.vel[0] * (0.6 + Math.random() * 0.6) + (Math.random() - 0.5) * 2, e.vel[1] * (0.6 + Math.random() * 0.6) + (Math.random() - 0.5) * 2, e.vel[2] * (0.6 + Math.random() * 0.6) + (Math.random() - 0.5) * 2, e.col, 0.9 + Math.random() * 0.8, 0.28);
      else if (e.kind === "confetti" && !red) { const n = Math.round(e.n * (Q.eff === "mid" ? 0.6 : 1)); for (let k = 0; k < n; k++) { const c = e.cols[Math.floor(Math.random() * e.cols.length)]; spawn(particles.conf, (Math.random() - 0.5) * 18, 8.5 + Math.random() * 3, -10 + Math.random() * 14, (Math.random() - 0.5) * 2, -0.5 - Math.random(), (Math.random() - 0.5) * 1.5, c, 3.5 + Math.random() * 2.5, 0.38); } }
    });
    stepParticles(particles.sparks, dt, t, 1.3); stepParticles(particles.conf, dt, t, 1.5);
  }
  function renderPipeline() {
    renderer.setRenderTarget(rtScene); renderer.setClearColor(0x000000, 1); renderer.clear(true, false, false);
    renderer.render(sceneStage, ortho); renderer.render(sceneWorld, camera); renderer.render(sceneFlare, ortho);
    let bloomTex = null;
    if (Q.bloom && bloomRT.length) {
      let src = rtScene;
      for (let i = 0; i < bloomRT.length; i++) {
        downMat.uniforms.tSrc.value = src.texture; downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height); downMat.uniforms.uThresh.value = i === 0 ? 1.1 : 0;
        renderer.setRenderTarget(bloomRT[i]); renderer.render(sceneBlit.down, ortho); src = bloomRT[i];
      }
      for (let i = bloomRT.length - 1; i >= 1; i--) {
        upMat.uniforms.tSrc.value = bloomRT[i].texture; upMat.uniforms.uTexel.value.set(1 / bloomRT[i].width, 1 / bloomRT[i].height); upMat.uniforms.uK.value = 1;
        renderer.setRenderTarget(bloomRT[i - 1]); renderer.render(sceneBlit.up, ortho);
      }
      bloomTex = bloomRT[0].texture;
    }
    compMat.uniforms.tScene.value = rtScene.texture; compMat.uniforms.tBloom.value = bloomTex || rtScene.texture;
    renderer.setRenderTarget(null); renderer.render(sceneComp, ortho);
  }

  S.render = function (frame, dt, t) {
    if (fallback) { fallback.render(dt, t); if (S.auditOn && ++S.auditLog.frames % 6 === 0) { const v = S.audit(); if (v.length) { S.auditLog.violations += v.length; S.auditLog.worst = v.slice(0, 5); } } return; }
    if (!S.ok) return;
    if (Q.eff === "low" && t - Q.lastRender < 0.031) return;   // 省电档 30 fps 封顶
    const rdt = Q.lastRender ? Math.min(0.1, t - Q.lastRender) : dt; Q.lastRender = t;
    const r = drive(rdt, t);
    pushUniforms(r, t); drawParticles(r, rdt, t);
    renderPipeline();
    if (S.recTrack && S.recTrack.requestFrame) S.recTrack.requestFrame();
    adapt(rdt, t);
    if (S.auditOn) {
      if (++S.auditLog.frames % 6 === 0) { const v = S.audit(); if (v.length) { S.auditLog.violations += v.length; S.auditLog.worst = v.slice(0, 5); } }
      if (S.auditLog.frames % 10 === 0) pixelAudit();
    }
  };

  /* 自适应画质:动态分辨率(0.55~1.0)先动,不够再降档;稳定 60 fps 后每 6 秒试探性回升一次,试探失败就锁 45 秒 */
  function adapt(dt, t) {
    Q.ema += (dt * 1000 - Q.ema) * 0.08; S.stats.ms = Q.ema;
    if (document.hidden || S.opts.capture || Q.eff === "low") return;
    const slow = Q.ema > 20;
    if (slow) { Q.slowN += dt; Q.fastT = 0; } else { Q.slowN = 0; Q.fastT += dt; }
    if (Q.slowN > 1.2) {
      Q.slowN = 0;
      if (Q.probeAt > 0 && t - Q.probeAt < 4) Q.noUpUntil = t + 45;   // 刚升就变慢:回退并锁定
      if (Q.dyn > 0.6) { Q.dyn = Math.max(0.55, Q.dyn - 0.12); allocTargets(); }
      else if (S.opts.quality === "auto" && Q.tier !== "low") { Q.tier = Q.tier === "high" ? "mid" : "low"; Q.dyn = 0.85; Q.downgrades++; applyTier(); allocTargets(); }
      S.stats.downgrades = Q.downgrades;
    } else if (Q.fastT > 6 && Q.dyn < 1 && t > Q.noUpUntil) { Q.fastT = 0; Q.dyn = Math.min(1, Q.dyn + 0.06); Q.probeAt = t; allocTargets(); }
  }

  /* ---------- 同步基准:每帧后 readPixels 强制 GPU 完成,得到真实单帧耗时(不受 vsync 限制) ---------- */
  S.bench = function (n, scenario) {
    if (!S.ok) return null;
    const px = new Uint8Array(4), saveQ = { dyn: Q.dyn }; Q.dyn = 1; allocTargets();
    const times = []; let t = performance.now() / 1000;
    for (let i = 0; i < n + 6; i++) {
      t += 1 / 60; if (scenario) scenario(i, t);
      const t0 = performance.now(); Q.lastRender = 0;
      const rr = drive(1 / 60, t); pushUniforms(rr, t); drawParticles(rr, 1 / 60, t); renderPipeline();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (i >= 6) times.push(performance.now() - t0);
    }
    Q.dyn = saveQ.dyn; allocTargets(); times.sort((a, b) => a - b);
    return { avg: times.reduce((a, b) => a + b, 0) / times.length, p50: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1], n: times.length, rt: [Q.rw, Q.rh], tier: Q.eff, hdr };
  };

  /* ---------- 灯光语言审计 ---------- */
  const isGuideHue255 = (r, g, b) => Dir.isGuideHue([r / 255, g / 255, b / 255], 0.25);
  S.audit = function () {
    const bad = dir.audit(), U = stageMat.uniforms;
    for (let i = 0; i < MAXL; i++) { const c = U.uBC.value[i]; if (c.w > 0.01) { const m = Math.max(c.x, c.y, c.z), toS = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); if (m > 0 && isGuideHue255(toS(c.x / m) * 255, toS(c.y / m) * 255, toS(c.z / m) * 255)) bad.push("uniform lamp" + i); } }
    return bad;
  };
  let pxCanvas = null, pxCtx = null;
  function pixelAudit() {   // 读真实渲染出来的像素:每 20 帧一次,统计带青绿色相的像素
    if (!pxCanvas) { pxCanvas = document.createElement("canvas"); pxCanvas.width = 192; pxCanvas.height = 108; pxCtx = pxCanvas.getContext("2d", { willReadFrequently: true }); }
    pxCtx.drawImage(canvas, 0, 0, 192, 108); const d = pxCtx.getImageData(0, 0, 192, 108).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (isGuideHue255(d[i], d[i + 1], d[i + 2]) && Math.max(d[i], d[i + 1], d[i + 2]) > 24) { n++; if (S.auditLog.worst.length < 3) S.auditLog.worst.push("pixel#" + (i / 4) + " rgb(" + d[i] + "," + d[i + 1] + "," + d[i + 2] + ")"); }
    S.auditLog.pixel += n; S.auditLog.pixelFrames++;
  }
  S.setAudit = (on) => { S.auditOn = !!on; };
  S.onBus = (fn) => { S.busListeners.push(fn); return () => { S.busListeners = S.busListeners.filter((f) => f !== fn); }; };
  S.canvasStream = () => { const el = fallback ? fallback.canvas : canvas, st = el.captureStream(0); S.recTrack = st.getVideoTracks()[0]; return st; };
  S.stopStream = () => { S.recTrack = null; };
  S.styleName = () => (rig ? rig.styleName + (S.opts.styleMode === "auto" ? "(自动)" : "") : "");
  S.info = () => (renderer ? { gpu: S.gpu, mode: S.mode, hdr, style: rig.styleName, section: rig.section, energy: +rig.energy.toFixed(2), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, tex: renderer.info.memory.textures, geoms: renderer.info.memory.geometries, tier: Q.eff, dyn: +Q.dyn.toFixed(2), rt: [Q.rw, Q.rh], ms: S.stats.ms } : { mode: S.mode, gpu: S.gpu });
  S.rig = () => rig; S.Q = Q; S.tune = (k, v) => { const u = stageMat.uniforms[k].value; if (u && u.set) u.set(...[].concat(v)); else stageMat.uniforms[k].value = v; };

  /* ---------- 无 GPU 加速 / 无 WebGL 的降级:2D 画布版舞台(同一份 rig:光束、光晕、屏墙均衡器、地面光斑、剪影、观众)----------
     纯软件渲染(远程桌面、虚拟机、驱动被禁用)下 GLSL 版要几百毫秒一帧(见第 5 节实测),所以直接换成这一版:CPU 上稳稳 60 fps。 */
  function initFallback(why) {
    S.reason = why || S.reason;
    const c = document.createElement("canvas"); c.className = "stage-canvas"; c.setAttribute("aria-label", "虚拟舞台(平面版)"); container.appendChild(c);
    const x = c.getContext("2d"); dir = S.dir = Dir.create({ Core }); rig = dir.rig; let w = 2, h = 2;
    const orig = Core.press; Core.press = (id, down) => { orig(id, down); if (down && id < 100 && id % 10 >= 1 && id % 10 <= 8 && !(Core.hw && Core.hw.active)) dir.hit(id, 0, performance.now() / 1000); };
    Core.on("finish", () => dir.celebrate(performance.now() / 1000)); Core.on("hwFinish", () => dir.celebrate(performance.now() / 1000));
    const rgba = (col, a, k) => "rgba(" + col.map((v) => Math.round(clamp(v * (k == null ? 1 : k), 0, 1) * 255)).join(",") + "," + clamp(a, 0, 1).toFixed(3) + ")";
    const glow = (px, py, r, col, a) => { const g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, rgba(col, a)); g.addColorStop(1, rgba(col, 0)); x.fillStyle = g; x.fillRect(px - r, py - r, r * 2, r * 2); };
    fallback = {
      canvas: c,
      resize() { const r = container.getBoundingClientRect(); w = c.width = Math.max(2, Math.round(r.width)); h = c.height = Math.max(2, Math.round(r.height)); c.style.width = r.width + "px"; c.style.height = r.height + "px"; },
      render(dt, t) {
        A.drainEvents((ev) => dir.audioEvent(ev));
        const r = dir.update(Math.min(dt, 0.1), t, directorInputs(dt, t));
        r.spawn.length = 0;
        x.globalCompositeOperation = "source-over"; x.fillStyle = "#090706"; x.fillRect(0, 0, w, h);
        const asp = w / h, cx = w / 2, ww = Math.min(w * 0.7, h * 1.15 * Math.min(1, asp / 1.4)), wh = ww / 2.1, wy = h * 0.2, wb = wy + wh;
        // 屏墙
        const dim = r.wall.dim; x.fillStyle = rgba(r.tint, 0.12 * dim + 0.02); x.fillRect(cx - ww / 2, wy, ww, wh);
        const n = 32; for (let b = 0; b < n; b++) { const v = clamp(r.wall.bands[Math.min(15, b >> 1)], 0, 1) * r.wall.mode[1], bh = wh * 0.95 * v; if (bh < 2) continue; x.fillStyle = rgba(dir.ramp(b / (n - 1)), 0.9 * dim); x.fillRect(cx - ww / 2 + (b + 0.12) * ww / n, wb - bh, ww / n * 0.76, bh); }
        r.wall.hits.forEach((hh) => glow(cx - ww / 2 + (0.12 + 0.76 * hh.x) * ww, wb - (0.2 + 0.65 * hh.y) * wh, wh * (0.12 + hh.age * 0.2), hh.col, 0.7 * Math.exp(-hh.age * 1.5) * r.wall.mode[3]));
        if (r.wall.kick > 0.05) glow(cx, wy + wh / 2, wh * 0.5, r.tint, 0.5 * r.wall.kick * r.wall.mode[2]);
        // 地面(渐变)与冲击波
        const fg = x.createLinearGradient(0, wb, 0, h); fg.addColorStop(0, "rgba(40,28,26,0.9)"); fg.addColorStop(1, "rgba(9,7,6,1)"); x.fillStyle = fg; x.fillRect(0, wb, w, h - wb);
        r.fx.shocks.forEach((s) => { x.strokeStyle = rgba(s.col, 0.5 * s.amp * (1 - s.age / 1.6)); x.lineWidth = 3; x.beginPath(); x.ellipse(cx, wb + h * 0.12, w * 0.1 + s.age * w * 0.35, h * 0.02 + s.age * h * 0.1, 0, 0, 7); x.stroke(); });
        // 光束 + 灯口光晕 + 地面光斑
        x.globalCompositeOperation = "lighter";
        r.lamps.forEach((L, li) => {
          const sx = cx + (L.pos[0] / 11) * (w * 0.46), sy = h * (L.pos[2] < -12 ? 0.09 : L.pos[1] < 2 ? 0.7 : 0.14);
          S.lampPx[li] = [sx / w, sy / h];
          if (L.inten < 0.02) return;
          const len = h * (L.dir[1] < 0 ? 0.9 * -L.dir[1] + 0.25 : 0.5), ex = sx + L.dir[0] * h * 1.1, ey = L.dir[1] < 0 ? sy + len : sy - L.dir[1] * h * 0.7 - 20;
          const g = x.createLinearGradient(sx, sy, ex, ey); g.addColorStop(0, rgba(L.col, 0.5 * L.inten)); g.addColorStop(1, rgba(L.col, 0.04 * L.inten));
          const nx = -(ey - sy), ny = ex - sx, nl = Math.hypot(nx, ny) || 1, sp = Math.max(4, L.tan * Math.hypot(ex - sx, ey - sy) * 1.1);
          x.fillStyle = g; x.beginPath(); x.moveTo(sx, sy); x.lineTo(ex + nx / nl * sp, ey + ny / nl * sp); x.lineTo(ex - nx / nl * sp, ey - ny / nl * sp); x.closePath(); x.fill();
          glow(sx, sy, h * 0.06 * (0.6 + L.inten), L.col, 0.85 * Math.min(1, L.inten));
          if (L.dir[1] < 0 && ey > wb) { x.fillStyle = rgba(L.col, 0.35 * L.inten); x.beginPath(); x.ellipse(ex, ey, sp * 1.3, sp * 0.35, 0, 0, 7); x.fill(); }
        });
        x.globalCompositeOperation = "source-over";
        // 乐队剪影
        const P = rig.perf, base = h * 0.78;
        x.fillStyle = "#050404"; x.beginPath(); x.ellipse(cx, base - h * 0.05, w * 0.045, h * 0.05, 0, 0, 7); x.fill(); x.fillRect(cx - w * 0.07, base - h * 0.1, w * 0.14, h * 0.04);
        x.fillStyle = rgba(dir.DRUM, 0.04 + 0.85 * P.drum.e * Math.max(P.drum.k, 0.2)); x.beginPath(); x.ellipse(cx, base - h * 0.05, w * 0.034, h * 0.038, 0, 0, 7); x.fill();
        x.fillStyle = "#050404"; x.fillRect(cx - w * 0.2, base - h * 0.14, w * 0.018, h * 0.14); x.beginPath(); x.arc(cx - w * 0.191, base - h * 0.16, w * 0.011, 0, 7); x.fill();
        x.fillRect(cx + w * 0.15, base - h * 0.07, w * 0.1, h * 0.012); x.fillRect(cx + w * 0.185, base - h * 0.12, w * 0.025, h * 0.05); x.beginPath(); x.arc(cx + w * 0.197, base - h * 0.14, w * 0.011, 0, 7); x.fill();
        // 观众
        for (let i = 0; i < 34; i++) {
          const hx = (i + 0.5) * w / 34, hy = h * 0.93 + Math.sin(t * (1.6 + (i % 5) * 0.3) + i) * 2 * (0.4 + r.fx.crowd) - (i % 3) * h * 0.012, rr = w / 62;
          x.beginPath(); x.arc(hx, hy, rr, 0, 7); x.fill(); x.fillRect(hx - rr * 1.5, hy + rr * 0.8, rr * 3, h);
          if (((i * 7919) % 100) / 100 < r.fx.hands * 0.7) { x.lineWidth = rr * 0.5; x.strokeStyle = "#050404"; x.beginPath(); x.moveTo(hx + rr, hy + rr); x.lineTo(hx + rr * 1.6 + Math.sin(t * 3 + i) * rr, hy - rr * 3.4); x.stroke(); }
        }
        if (r.fx.flash > 0.05) { x.fillStyle = "rgba(255,230,200," + 0.22 * r.fx.flash + ")"; x.fillRect(0, 0, w, h); }
        if (r.fx.blackout > 0.1) { x.fillStyle = "rgba(0,0,0," + r.fx.blackout + ")"; x.fillRect(0, 0, w, h); }
        if (S.recTrack && S.recTrack.requestFrame) S.recTrack.requestFrame();
      },
    };
    S.mode = "2d"; S.ok = true; S.resize = () => fallback.resize(); fallback.resize();
    new ResizeObserver(() => fallback.resize()).observe(container);
    S.audit = () => dir.audit();
    S.bench = (n, scenario) => { const ts = []; let t = performance.now() / 1000; for (let i = 0; i < n + 4; i++) { t += 1 / 60; if (scenario) scenario(i, t); const t0 = performance.now(); fallback.render(1 / 60, t); x.getImageData(0, 0, 1, 1); if (i >= 4) ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return { avg: ts.reduce((a, b) => a + b, 0) / ts.length, p95: ts[Math.floor(ts.length * 0.95)], rt: [w, h], tier: "2d", n: ts.length }; };
    S.info = () => ({ mode: "2d", gpu: S.gpu || "none", reason: S.reason, ms: S.stats.ms });
    S.rig = () => rig; S.Q = Q; S.tune = () => {};
    return S;
  }
  window.LPStage = S;
})();
