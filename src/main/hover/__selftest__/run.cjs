/**
 * 悬停显隐自测（对齐原版 hoverReveal）。
 *
 * 运行：node src/main/hover/__selftest__/run.cjs
 *
 * 关键契约：光标移出 → 通知渲染层「消失」；移回 → 恢复；
 * 关闭开关时绝不能让窗口留在隐藏态（否则窗口会消失且再也回不来）。
 */
const fs=require('fs'),os=require('os'),path=require('path'),Module=require('module');
function findRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到项目根目录')
}
const ROOT = findRoot(__dirname)
const DATA=path.join(os.tmpdir(),'suisi-hover-'+process.pid); fs.mkdirSync(DATA,{recursive:true});
const ts=require(path.join(ROOT,'node_modules','typescript'));
require.extensions['.ts']=(m,f)=>{const s=fs.readFileSync(f,'utf8');const o=ts.transpileModule(s,{fileName:f,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});m._compile(o.outputText,f)};
const or=Module._resolveFilename;Module._resolveFilename=function(r,...a){if(r.startsWith('@shared/'))r=path.join(ROOT,'src',r.slice(1));return or.call(this,r,...a)};
let cursor={x:0,y:0};
const sent=[];
const fakeWin={ id:1, isDestroyed:()=>false, isVisible:()=>true, getBounds:()=>({x:100,y:100,width:400,height:300}),
  webContents:{send:(ch,p)=>sent.push([ch,p])}, once:()=>{}, setOpacity:()=>{}, isResizable:()=>true, getSize:()=>[400,300] };
const realLoad=Module._load;
Module._load=function(r,...a){
  if(r==='electron') return { app:{getPath:()=>DATA,getName:()=>'x',isPackaged:false}, ipcMain:{handle:()=>{},on:()=>{}}, screen:{ getCursorScreenPoint:()=>cursor, getAllDisplays:()=>[{id:1,size:{width:1440,height:900},scaleFactor:1,bounds:{x:0,y:0,width:1440,height:900}}], getPrimaryDisplay:()=>({id:1,size:{width:1440,height:900},scaleFactor:1,bounds:{x:0,y:0,width:1440,height:900}}) }, desktopCapturer:{getSources:async()=>[]}, BrowserWindow:{fromWebContents:()=>fakeWin} };
  return realLoad.apply(this,[r,...a]);
};
const {settingsStore}=require(path.join(ROOT,'src/main/store/settings.ts'));
const {startHoverTracking,stopHoverTracking}=require(path.join(ROOT,'src/main/hover.ts'));
let pass=0,fail=0; const check=(n,ok,d)=>{ok?pass++:fail++;console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  —  '+d:''}`)};

(async()=>{
  settingsStore.patch({stealth:{hoverReveal:true, hoverRevealOpacity:0.06}});
  cursor={x:200,y:200}; // 窗口内
  startHoverTracking(fakeWin,'quizbar');
  await new Promise(r=>setTimeout(r,200));
  check('悬停：光标在窗口内 → 不隐藏', sent.filter(s=>s[1]===true).length===0, JSON.stringify(sent));
  cursor={x:900,y:800}; // 窗口外
  await new Promise(r=>setTimeout(r,300));
  check('悬停：光标移出 → 通知隐藏', sent.some(s=>s[1]===true), JSON.stringify(sent));
  cursor={x:200,y:200};
  await new Promise(r=>setTimeout(r,300));
  check('悬停：光标移回 → 通知恢复', sent.filter(s=>s[1]===false).length>0, JSON.stringify(sent));

  // 关掉开关必须恢复显示，否则窗口会「消失且回不来」
  sent.length=0; settingsStore.patch({stealth:{hoverReveal:false}});
  cursor={x:900,y:800};
  await new Promise(r=>setTimeout(r,300));
  check('关闭悬停显隐：不会把窗口留在隐藏态', !sent.some(s=>s[1]===true), JSON.stringify(sent));
  stopHoverTracking(fakeWin);
  console.log(`\n===== 汇总：${pass}/${pass+fail} 通过 =====`);
  fs.rmSync(DATA,{recursive:true,force:true});
  process.exit(fail?1:0);
})();
