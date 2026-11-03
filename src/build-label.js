export function buildIdentity(build){
  const version=build?.version||'Unknown version';
  const id=typeof build?.id==='string'&&/^[\w-]{8,64}$/.test(build.id)?build.id.slice(0,8):'';
  return id?`${version} · ${id}`:version;
}
