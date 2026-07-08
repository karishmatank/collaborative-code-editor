import { initializeModal } from './modal.js';
import { initializeResizers } from './resizer.js';
import { initializeEditor } from './editor.js';
import { initializeOutput, renderIFrame, setOutputContent } from './output.js';
import { initializeCollaboration } from './collaboration.js';

const languageDropdown = document.getElementById('language-select');
const runBtn = document.getElementById('run-btn');
const resetBtn = document.getElementById('reset-btn');
const htmlDivider = document.getElementById('divider-html');
const iframePane = document.getElementById('iframe-pane');

let editorController;
let collabController;

function isReturningUser() {
  return localStorage.getItem('username') !== null;
}

function applyLanguageChange(newLanguage) {
  languageDropdown.value = newLanguage;
  editorController.switchLanguage(newLanguage);
  collabController.switchLanguage(newLanguage, editorController.getCode(newLanguage));

  if (newLanguage === 'html') {
    runBtn.disabled = true;
    htmlDivider.hidden = false;
    iframePane.hidden = false;
  } else {
    runBtn.disabled = false;
    htmlDivider.hidden = true;
    iframePane.hidden = true;
  }
}

function toggleResetBtn(language) {
  if (language === 'html') {
    resetBtn.hidden = true;
  } else {
    resetBtn.hidden = false;
  }
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
  // TODO: Pass in a valid room ID when initializing the collaborator + pass in language
  // const padId = window.location.pathname.split('/').pop();
  const padId = null;
  const language = 'python';
  editorController = initializeEditor(padId, language);

  // TODO: Pass in a valid room ID when initializing the collaborator
  collabController = initializeCollaboration(
    padId, 
    editorController.editor, 
    language,
    editorController.getCode(language)
  );

  // Set the dropdown to sync with initial language
  languageDropdown.value = language;

  // Set the latest output from the room
  // For a joining user, the WebSocket connection sync is async, and it
  // takes a moment. Meanwhile, we don't want to run any initialization
  // code that relies on Y.Map before WebSocket is completely set up
  collabController.onFirstSync(() => {
    setOutputContent(collabController.output);

    const syncedLanguage = collabController.language;
    if (syncedLanguage && syncedLanguage !== languageDropdown.value) {
      applyLanguageChange(syncedLanguage);
    }
  });

  // Language dropdown listener to change editor
  // If the language selected is HTML, disable the run button and unhide the iframe
  // Also with HTML, then change our populated output to be viewed all the time
  languageDropdown.addEventListener('change', event => {
    applyLanguageChange(event.target.value);
    collabController.language = event.target.value;
    collabController.output = '';

    toggleResetBtn(event.target.value);
  });

  // Render iframe with HTML mode upon changes in the editor
  editorController.onContentChange(event => {
    if (languageDropdown.value === 'html') {
      renderIFrame(event);
    }
  });

  // Look out for changes in Y.Map for language and output
  collabController.ymap.observe(event => {
    if (event.keysChanged.has('output')) {
      setOutputContent(collabController.output);
    }
    if (event.keysChanged.has('language') && !event.transaction.local) {
      let language = collabController.language;
      applyLanguageChange(language);
      toggleResetBtn(language);
    }
  });

  // Run button clicked
  runBtn.addEventListener('click', () => {
    // TODO: Run the code and get the real result back
    const preMessage = `${collabController.username} has run the code!\n\n`;
    const result = '...placeholder...';
    collabController.output = preMessage + result + '\n\n';
  });

  // Reset button clicked
  resetBtn.addEventListener('click', () => {
    collabController.output = '';
  });

});