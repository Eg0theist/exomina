/** A failed later continuation must not replace a successfully completed reply. */
export function finishRunFailure(run, error) {
  const { message, activity, completedResult } = run;
  if (completedResult) {
    activity.cut();
    activity.finish(completedResult.text, { failed: true });
    message.content = String(completedResult.text || '');
    message.continuationError = error;
    delete message.error;
  } else {
    activity.finish(null, { failed: true });
    message.error = error;
    if (!message.content) message.content = error;
  }
}
