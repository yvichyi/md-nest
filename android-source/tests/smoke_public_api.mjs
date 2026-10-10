// Diagnostic only: no account, passwords or user session are sent or logged.
// Tests public lyric and QR key endpoints from CI's network, not Android WebView.
import crypto from 'node:crypto';
const root='https://music.163.com';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
async function post(path, payload) {
  const response=await fetch(root+path, {
    method:'POST', signal:AbortSignal.timeout(10000),
    headers:{'User-Agent':ua,'Referer':root+'/','Origin':root,
      'Cookie':'os=pc; appver=3.1.17',
      'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(payload),
  });
  const text=await response.text();
  let json={};try{json=JSON.parse(text)}catch{}
  return {http:response.status,code:json.code, data:json};
}
function weapi(body) {
  const iv=Buffer.from('0102030405060708');
  const aes=(text,key)=>{
    const c=crypto.createCipheriv('aes-128-cbc',Buffer.from(key),iv);
    return Buffer.concat([c.update(String(text),'utf8'),c.final()]).toString('base64');
  };
  const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const secret=Array.from(crypto.randomBytes(16),x=>alphabet[x%alphabet.length]).join('');
  const params=aes(aes(JSON.stringify(body),'0CoJUm6Qyw8W8jud'),secret);
  const publicKey=`-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----`;
  const rsaMessage=Buffer.alloc(128);
  Buffer.from(secret.split('').reverse().join('')).copy(rsaMessage,112);
  const encSecKey=crypto.publicEncrypt({key:publicKey,padding:crypto.constants.RSA_NO_PADDING},rsaMessage).toString('hex');
  return {params,encSecKey};
}
let failures=0;
for(const [label,path,body,extract] of [
 ['public lyrics','/api/song/lyric',{id:'186016',tv:'-1',lv:'-1',rv:'-1',kv:'-1'}, d=>!!d.lrc?.lyric],
 ['QR key','/weapi/login/qrcode/unikey',weapi({type:3,csrf_token:''}),d=>!!(d.unikey || d.data?.unikey)],
]) {
 try {
  const result=await post(path,body);
  const success=result.http===200 && result.code===200 && extract(result.data);
  console.log(label,JSON.stringify({http:result.http,code:result.code,contentPresent:extract(result.data),pass:success}));
  if(!success)failures++;
 } catch(e){console.log(label,JSON.stringify({error:e.name,pass:false}));failures++;}
}
if(failures)process.exitCode=1;
