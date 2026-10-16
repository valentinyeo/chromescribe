const formData = new FormData();
formData.append('url', 'https://youtube.com/watch?v=test123');
formData.append('title', 'Test Audio');

const fileInput = document.querySelector('input[type=file]');
if (fileInput && fileInput.files[0]) {
  formData.append('audio', fileInput.files[0]);
}

fetch('https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/api/transcribe', {
  method: 'POST',
  body: formData
})
.then(r => r.json())
.then(d => console.log(JSON.stringify(d, null, 2)))
.catch(e => console.error(e));
