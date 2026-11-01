const fs=require('node:fs'),crypto=require('node:crypto');
function hashFile(file){const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),fd=fs.openSync(file,'r');try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest('hex');}finally{fs.closeSync(fd);}}
module.exports={hashFile};
