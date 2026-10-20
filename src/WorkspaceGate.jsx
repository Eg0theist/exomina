import React, { useEffect, useState } from 'react';
import { ArrowRight, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import App from './App.jsx';
import VaultSetup from './VaultSetup.jsx';
import BrandMark from './BrandMark.jsx';
import { api, getAuth, isDesktop, registerAppShell, signIn } from './transport.js';

export default function WorkspaceGate() {
  const [session, setSession] = useState(isDesktop ? { authenticated: true } : null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(!isDesktop);
  async function check() {
    setChecking(true); setError('');
    try { setSession(await getAuth()); } catch (err) { setError(err.message); }
    finally { setChecking(false); }
  }
  useEffect(() => { registerAppShell(); if (!isDesktop) check(); }, []);
  useEffect(() => {
    if (isDesktop || !session?.authenticated) return;
    return api.onEvent(event => { if (event.type === 'auth.required') { setSession({ authenticated: false }); setError('Your session ended. Sign in again to continue.'); } });
  }, [session?.authenticated]);
  if (isDesktop) return <VaultSetup><App session={session || {}} /></VaultSetup>;
  if (session?.authenticated) return <App session={session} />;
  return <main className="auth-page"><div className="auth-brand"><span className="brand-mark"><BrandMark /></span><span>Exomina</span></div><section className="auth-card"><div className="auth-lock"><LockKeyhole size={25} strokeWidth={1.5} /></div><div className="eyebrow">EXOMINA</div><h1>Your private workspace</h1><p>Your favourite AI tools in one place.<br />Sign in to access your chats and saved context.</p>{error && <p className="inline-error" role="alert">{error}</p>}{checking ? <div className="auth-loading" role="status"><LoaderCircle className="spin" size={18} />Checking your session…</div> : session ? <button className="primary-button auth-signin" onClick={() => { try { signIn(session.loginUrl); } catch (err) { setError(err.message); } }}><span>Sign in with Google</span><ArrowRight size={17} /></button> : <button className="secondary-button auth-signin" onClick={check}><RefreshCw size={16} />Try again</button>}<div className="auth-note"><LockKeyhole size={12} /><span>Access is limited to the workspace owner.</span></div></section><p className="auth-footer">Your AI, with shared memory, a browser, and tools.</p></main>;
}
