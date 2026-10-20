import React, {lazy, Suspense, useMemo, useState} from 'react';

const loadTerminal=()=>import('./PtyTerminal.jsx');

/** A failed optional view must leave the rest of the workspace usable. Retrying
 * mounts a new view of the same host session; it never opens another process. */
export class TerminalViewBoundary extends React.Component {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(){this.props.onError?.('The terminal view could not open. Try again from the terminal panel.');}
  render(){return this.state.failed?<div role="alert"><p>Could not open the terminal view.</p><button type="button" className="text-button" onClick={this.props.onRetry}>Try opening again</button></div>:this.props.children;}
}

export default function TerminalScreen(props){
  const [attempt,setAttempt]=useState(0);
  const Screen=useMemo(()=>lazy(loadTerminal),[attempt]);
  return <TerminalViewBoundary key={attempt} onError={props.onError} onRetry={()=>setAttempt(value=>value+1)}><Suspense fallback={<p className="terminal-context" role="status">Opening terminal…</p>}><Screen {...props}/></Suspense></TerminalViewBoundary>;
}
