import { initializeModal } from './modal.js';
import { initializeResizer } from './resizer.js';
import { initializeEditor } from './editor.js';

document.addEventListener('DOMContentLoaded', () => {
  initializeModal();
  initializeResizer();
  initializeEditor();
});