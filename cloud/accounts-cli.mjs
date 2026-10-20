import {AccountService} from './accounts.mjs';

// Owner tool: node cloud/accounts-cli.mjs invite friend@example.com [days]
// Uses the same EXOMINA_ACCOUNTS_DB and EXOMINA_ACCOUNTS_SECRET as accounts-start.mjs.
const [command,email,days='7']=process.argv.slice(2);
const env=process.env;
if(command!=='invite'||!email){process.stderr.write('Usage: node cloud/accounts-cli.mjs invite <email> [days]\n');process.exit(2);}
if(!env.EXOMINA_ACCOUNTS_DB||!env.EXOMINA_ACCOUNTS_SECRET){process.stderr.write('Set EXOMINA_ACCOUNTS_DB and EXOMINA_ACCOUNTS_SECRET.\n');process.exit(1);}
const accounts=new AccountService({file:env.EXOMINA_ACCOUNTS_DB,secret:env.EXOMINA_ACCOUNTS_SECRET,inviteOnly:true});
const ttl=Math.max(1,Math.min(30,Number(days)||7))*24*60*60*1000;
const invite=accounts.createInvite(email,{ttlMs:ttl});accounts.close();
process.stdout.write(`Invitation for ${invite.email}, valid until ${new Date(invite.expiresAt).toISOString()}:\n${invite.code}\nSingle use. Hand it over personally.\n`);
