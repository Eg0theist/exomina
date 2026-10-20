import {AccountService} from './accounts.mjs';
import {RelayService} from './relay.mjs';
import {createAccountServer} from './accounts-server.mjs';
import {fileURLToPath} from 'node:url';

// Account server + relay for the test circle (MOBILE-DESIGN.md). Listens on loopback; put Caddy in
// front for TLS. Environment:
//   EXOMINA_ACCOUNTS_DB      SQLite file (required)
//   EXOMINA_ACCOUNTS_SECRET  at least 16 random characters; the invite CLI must use the same value
//   EXOMINA_ACCOUNTS_PORT    default 4180
//   EXOMINA_TRUST_PROXY=1    read client IPs from X-Forwarded-For (only behind your own proxy)
const env=process.env;
if(!env.EXOMINA_ACCOUNTS_DB||!env.EXOMINA_ACCOUNTS_SECRET){process.stderr.write('Set EXOMINA_ACCOUNTS_DB and EXOMINA_ACCOUNTS_SECRET.\n');process.exit(1);}
const accounts=new AccountService({file:env.EXOMINA_ACCOUNTS_DB,secret:env.EXOMINA_ACCOUNTS_SECRET,inviteOnly:true});
const relay=new RelayService({accounts});
const server=createAccountServer(accounts,{relay,trustProxy:env.EXOMINA_TRUST_PROXY==='1',webRoot:env.EXOMINA_PHONE_DIST||fileURLToPath(new URL('../dist',import.meta.url))});
const port=Number(env.EXOMINA_ACCOUNTS_PORT||4180);
setInterval(()=>{accounts.purgeExpired();relay.purgeExpired();},60*60*1000).unref();
server.listen(port,'127.0.0.1',()=>process.stdout.write(`Exomina accounts and relay listening on 127.0.0.1:${port}\n`));
const stop=()=>{relay.close();server.close(()=>{accounts.close();process.exit(0);});setTimeout(()=>process.exit(0),3000).unref();};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
