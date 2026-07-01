import { initializeModal } from './modal.js';
import { initializeResizer } from './resizer.js';
import { initializeEditor } from './editor.js';
import { initializeResetBtn } from './reset.js';

function isReturningUser() {
  return localStorage.getItem('username') !== null;
}

document.addEventListener('DOMContentLoaded', async () => {
  initializeResizer();

  // If user already provided their name, render editor straight away
  // as the app is already visible.
  // Otherwise, render modal, then editor as app only visible after
  if (!isReturningUser()) {
    await initializeModal();
  }  
  // TODO: Persistence layer pass in the last language seen in the pad to initializeEditor
  initializeEditor();

  initializeResetBtn();

  // If the language selected is HTML, disable the run button
  const languageDropdown = document.getElementById('language-select');
  const runBtn = document.getElementById('run-btn');
  languageDropdown.addEventListener('change', event => {
    if (event.target.value === 'html') {
      runBtn.disabled = true;
    } else {
      runBtn.disabled = false;
    }
  });

});