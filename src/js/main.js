import { initializeModal } from './modal.js';
import { initializeResizers } from './resizer.js';
import { initializeEditor, getEditorController } from './editor.js';
import { initializeOutput, renderIFrame } from './output.js';

const languageDropdown = document.getElementById('language-select');
const runBtn = document.getElementById('run-btn');
const htmlDivider = document.getElementById('divider-html');
const iframePane = document.getElementById('iframe-pane');

function isReturningUser() {
  return localStorage.getItem('username') !== null;
}

document.addEventListener('DOMContentLoaded', async () => {
  initializeResizers();
  initializeOutput();

  // If user already provided their name, render editor straight away
  // as the app is already visible.
  // Otherwise, render modal, then editor as app only visible after
  if (!isReturningUser()) {
    // If Monaco initializes while its container is hidden (display: none), 
    // it can't measure the container dimensions
    await initializeModal();
  }  
  // TODO: Persistence layer pass in the last language seen in the pad to initializeEditor
  initializeEditor();

  // If the language selected is HTML, disable the run button and unhide the iframe
  languageDropdown.addEventListener('change', event => {
    if (event.target.value === 'html') {
      runBtn.disabled = true;
      htmlDivider.hidden = false;
      iframePane.hidden = false;
    } else {
      runBtn.disabled = false;
      htmlDivider.hidden = true;
      iframePane.hidden = true;
    }
  });

  // Render iframe with HTML mode upon changes in the editor
  getEditorController().onContentChange(event => {
    if (languageDropdown.value === 'html') {
      renderIFrame(event);
    }
  });
});