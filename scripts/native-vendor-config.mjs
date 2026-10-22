const PYTHON_TARGETS = Object.freeze({
  'darwin-arm64': ['aarch64-apple-darwin','8dc60610a82f1e73be7faf964383e02520f95f6e39592a5c37c3809f5a7b798e'],
  'darwin-x64': ['x86_64-apple-darwin','ce9c748c8f7525c0052247edb2435fdb1cac89c77e687e0e199eaf2b827668c2'],
  'linux-arm64': ['aarch64-unknown-linux-gnu','c6857c65b996701a5da104cbb49b35249c0c026dc0664239b04f7156aa88326a'],
  'linux-x64': ['x86_64-unknown-linux-gnu','f829adc9d888e76c8801b4799ed444188d35239fcae3a9808a99ec5cb0d8d92c'],
});
const CUA_TARGETS = Object.freeze({
  'darwin-arm64': ['darwin-universal','bf90ac5db76f44baff47e256cb7355959be3e8df3706b9d178505720f02d74c1'],
  'darwin-x64': ['darwin-universal','bf90ac5db76f44baff47e256cb7355959be3e8df3706b9d178505720f02d74c1'],
  'linux-arm64': ['linux-arm64','63a1e858a1a407c44ceb407ad133909b8cddedd713aea3b56d7ccb6db784eb48'],
  'linux-x64': ['linux-x86_64','a4759cc41c00691a345f08abfc28ece79aef41447d27a463ddd8662939fa3378'],
});

export function nativeVendorTargets(platform=process.platform,arch=process.arch) {
  const python=PYTHON_TARGETS[`${platform}-${arch}`],cua=CUA_TARGETS[`${platform}-${arch}`];
  if(!python||!cua)throw Error(`No verified native vendor artifacts for ${platform}/${arch}.`);
  const pythonFile=`cpython-3.13.17+20261021-${python[0]}-install_only_stripped.tar.gz`;
  const cuaFile=`cua-driver-rs-0.33.4-${cua[0]}.tar.gz`;
  return [
    {dir:'python',version:'3.13.17+20261021',file:pythonFile,prefix:'python',sha256:python[1],
      url:`https://github.com/astral-sh/python-build-standalone/releases/download/20261021/${encodeURIComponent(pythonFile)}`,
      executable:'bin/python3',license:'Public CPython standalone distribution; embedded license notices retained.'},
    {dir:'cua-driver',version:'0.33.4',file:cuaFile,prefix:`cua-driver-rs-0.33.4-${cua[0]}`,sha256:cua[1],
      url:`https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.4/${cuaFile}`,
      executable:platform==='darwin'?'CuaDriver.app/Contents/MacOS/cua-driver':'cua-driver',
      license:'Official Cua distribution; LICENSE and THIRD_PARTY_NOTICES retained.'},
  ];
}

export function validateNativeArchiveEntries(entries,target) {
  if(!entries.length||entries.length>100000)throw Error('Official runtime archive has an invalid entry count.');
  let hasExecutable=false;
  for(const entry of entries) {
    const name=entry.replace(/^\.\//,'');
    if(!name||name.includes('\\')||name.includes(':')||name.startsWith('/')||name.split('/').some(part=>part==='..'))throw Error('Official runtime archive has an unsafe path.');
    if(name!==target.prefix&&name!==target.prefix+'/'&&!name.startsWith(target.prefix+'/'))throw Error('Official runtime archive has an unexpected root.');
    if(name===`${target.prefix}/${target.executable}`)hasExecutable=true;
  }
  if(!hasExecutable)throw Error('Official runtime archive does not contain the expected executable.');
}
