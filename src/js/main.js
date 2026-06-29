import { initializeModal } from './modal.js';
import { initializeResizer } from './resizer.js';
import { initializeEditor } from './editor.js';

function isReturningUser() {
  return localStorage.getItem('username') !== null;
}

document.addEventListener('DOMContentLoaded', () => {
  initializeResizer();

  // If user already provided their name, render editor straight away
  // as the app is already visible.
  // Otherwise, render modal, then editor as app only visible after
  if (isReturningUser()) {
    initializeEditor();
  } else {
    initializeModal(initializeEditor);
  }  

});