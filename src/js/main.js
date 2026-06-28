import { processUserName } from './modal.js';

document.addEventListener('DOMContentLoaded', () => {
  let nameModalSubmit = document.getElementById('name-submit');
  nameModalSubmit.addEventListener('click', processUserName);
});