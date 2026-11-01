// Executes the actual generated snippet, not a duplicate implementation.
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const executable=process.argv[2];assert(executable,'Pass compiled external_protocol_navigation.exe');
const target='custom+test://host/";globalThis.injected=true;//\n\\\u2028😀';
const source='https://example.invalid/source?value=";attack()#old';
const code=execFileSync(executable,[target,source],{encoding:'utf8',windowsHide:true});
let checked=0;
for(const [href,allowed] of [[source,true],[source.replace('#old','#new'),true],[source.split('#')[0],true],['https://other.invalid/source',false],['https://example.invalid/changed',false],['https://example.invalid/source?value=";attack()extra',false]]){
 const window={location:{href}};
 const context=vm.createContext({window});
 vm.runInContext('String.prototype.slice=String.prototype.indexOf=String.prototype.split=function(){throw Error("page helper called")};'+code,context,{timeout:1000});
 assert.equal(window.location.href,allowed?target:href);
 assert.equal(context.injected,undefined);
 checked++;
}
console.log(`PASS ${checked} generated-navigation cases: source identity, hash changes, escaping, no page helper calls`);
