import { createHash } from 'node:crypto';
import { featureDisabled } from './features.mjs';
import { deliveryContract } from './delivery-contract.mjs';

/** Bind user review to the resolved report, policy and paired connector epoch.
 * This is used only from the owner's Library UI, never from model-supplied
 * approval assertions or an unattended background chat. */
export function workflowDelivery({ policy, getSettings, getHub, requestApproval, isClosing = () => false }) {
  const action = binding => ({ kind:'external', tool:'workflow_delivery', target:`${binding.channel}:${binding.recipient}`, });
  const checkDelivery = binding => {
    if (isClosing()) throw Error('Exomina is closing. Review delivery after restarting.');
    const settings = getSettings();
    if (featureDisabled('workflow_delivery',settings)) throw Error('Workflow delivery is disabled.');
    const verdict = policy.evaluate(action(binding));
    if (verdict.decision === 'deny') throw Error(verdict.reason);
    const connector = getHub()?.scheduledDeliveryBinding(binding.channel,binding.recipient);
    if (!connector) throw Error('This recipient is no longer paired or the bot is disconnected.');
    return createHash('sha256').update(JSON.stringify({binding, mode:policy.mode, rules:policy.rules, connector,contract:deliveryContract(binding.channel)})).digest('hex');
  };
  return {
    checkDelivery,
    approveDelivery: async binding => {
      checkDelivery(binding);
      return requestApproval({ title:'Deliver saved workflow report', requireConfirmation:true,
        action:action(binding), input:{runId:binding.runId,channel:binding.channel,recipient:binding.recipient,sha256:binding.sha256,bytes:binding.bytes},
        detail:`Send this saved report to ${binding.channel} recipient ${binding.recipient}.\nWorkflow: ${binding.runId}\nTitle: ${binding.name}\nSHA-256: ${binding.sha256}\nReport bytes: ${binding.bytes}\n\n${binding.text}` });
    },
    deliver: (task,text) => getHub().sendScheduled(task.delivery,task.recipient,task.name+'\n\n'+text,{
      validate:()=>checkDelivery(task.binding)===task.authorization,
      onProgress:task.recordProgress,
    }),
  };
}
