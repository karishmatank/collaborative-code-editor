import { isEmptyUserName, isLengthyUserName } from "./username";

function hideNameModal() {
  // Setting hidden=true is safe — we only ever hide the modal via JS,
  // never need to override it back to visible with CSS.
  document.getElementById('name-modal').hidden = true;
}

function showApp() {
  // Use a CSS class rather than the hidden attribute. The hidden attribute
  // carries display:none !important in all modern browsers, which can't be
  // overridden by author styles (as the .returning-user rule needs to do).
  document.documentElement.classList.add('returning-user');
}

// Process a username from the modal
function processUserName(event) {
  let submittedName = document.getElementById('name-input').value;
  let cleanedName = submittedName.trim();
  let errorP = document.getElementById('name-error');

  if (isEmptyUserName(cleanedName)) {
    errorP.textContent = 'Provided name is invalid. Please try again.';
    return false;
  } else if (isLengthyUserName(cleanedName)) {
    errorP.textContent = 'Provided name is too long. Please enter a shorter name.';
    return false;
  } else {
    // Hide modal and show the app
    hideNameModal();
    showApp();

    // Use localStorage to store cookie in the browser
    localStorage.setItem('username', cleanedName);

    return true;
  }
}

export function initializeModal() {
  return new Promise(resolve => {
    let nameModalSubmit = document.getElementById('name-submit');
    nameModalSubmit.addEventListener('click', event => {
      const success = processUserName(event);
      if (success) {
        resolve();
      }
    });
  });
}