export const SIDEBAR_PAGE_SIZE=60;
/** Pinned rows stay visible. A selected older row stays reachable after search. */
export function sidebarWindow(chats,limit=SIDEBAR_PAGE_SIZE,selectedId){
 const recent=chats.filter(c=>!c.pinned),shown=recent.slice(0,limit),selected=recent.find(c=>c.id===selectedId);
 if(selected&&!shown.includes(selected))shown.push(selected);
 return {chats:shown,remaining:Math.max(0,recent.length-shown.length)};
}
