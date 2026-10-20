import React from 'react';
import './selectable-text.css';

/** A read-only text region with Select All confined to its own contents. */
export default function SelectableText({ as: Tag = 'pre', className = '', onKeyDown, onClick, ...props }) {
  function click(event) {
    onClick?.(event);
    if (event.defaultPrevented || event.target.closest('a, button, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    // Chromium can keep a surrounding message focused when its nested code is clicked.
    // Focus after the native click, without cancelling text dragging or double-click selection.
    if (event.target.closest('.selectable-text') === event.currentTarget) event.currentTarget.focus({ preventScroll: true });
  }
  function keydown(event) {
    onKeyDown?.(event);
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') return;
    // Nested editable controls keep the browser's native selection behaviour.
    if (event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const element = event.currentTarget, selection = element.ownerDocument.getSelection();
    if (!selection) return;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    event.preventDefault();
    event.stopPropagation();
  }
  return <Tag tabIndex={0} {...props} className={`selectable-text ${className}`.trim()} onKeyDown={keydown} onClick={click} />;
}
