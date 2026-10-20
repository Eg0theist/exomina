import React from 'react';
import { Brain, Gauge, Layers3 } from 'lucide-react';
import { MODEL_TASKS, modelTaskChoice } from '../desktop/model-choice-guide.mjs';
import { modelVisible } from '../desktop/model-preferences.mjs';
import './model-choice-guide.css';

const icons = { quick: Gauge, everyday: Layers3, difficult: Brain };
export default function ModelChoiceGuide({ models, provider, preferences, onModel }) {
  const visible = models.filter(item => modelVisible(preferences, provider, item.id));
  const allowDefault = modelVisible(preferences, provider, 'auto');
  return <details className="model-choice-guide"><summary>Help me choose</summary><p>Choose a starting point for this task. You can change it at any time.</p><div className="model-task-choices">{MODEL_TASKS.map(task => {
    const choice = modelTaskChoice(visible, task.id, { allowDefault }), Icon = icons[task.id];
    return <button type="button" key={task.id} disabled={!choice} onClick={() => onModel(choice.model, choice.effort)} aria-label={'Use suggestion: ' + task.title}><Icon size={19}/><span><strong>{task.title}</strong><small>{task.example}</small><em>{choice ? `${choice.label} · ${choice.effort ? choice.effort + ' effort' : 'default effort'}` : 'Choose a visible model or wait for its options to load.'}</em></span></button>;
  })}</div><p>The model determines its capabilities. Effort adjusts how much reasoning it uses; higher settings can take longer and use more allowance. Reply length still follows your request.</p><p>These suggestions use known model families and the options reported by your connection. Check important results against their sources.</p></details>;
}
