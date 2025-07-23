class VisitorSystem {
  constructor() {
    this.video = document.getElementById('video');
    this.canvas = document.getElementById('canvas');
    this.captureBtn = document.getElementById('capture-btn');
    this.visitorForm = document.getElementById('visitor-form');
    this.photoData = document.getElementById('photo-data');
    this.visitorBadge = document.getElementById('visitor-badge');
    this.printBtn = document.getElementById('print-btn');
    this.stream = null;
    
    this.init();
  }
  
  init() {
    this.setupCamera();
    this.setupEventListeners();
  }
  
  setupCamera() {
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: true })
        .then(stream => {
          this.stream = stream;
          this.video.srcObject = stream;
        })
        .catch(error => {
          console.error("Camera error:", error);
          this.showError("Could not access the camera. Please ensure you've granted camera permissions.");
        });
    } else {
      this.showError("Camera API not supported in your browser.");
    }
  }
  
  setupEventListeners() {
    this.captureBtn.addEventListener('click', this.capturePhoto.bind(this));
    this.visitorForm.addEventListener('submit', this.handleFormSubmit.bind(this));
    this.printBtn.addEventListener('click', this.printBadge.bind(this));
  }
  
  capturePhoto(e) {
    e.preventDefault();
    
    if (!this.stream) {
      this.showError("Camera not initialized");
      return;
    }
    
    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;
    this.canvas.getContext('2d').drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    
    this.photoData.value = this.canvas.toDataURL('image/png');
    this.stopCamera();
  }
  
  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
  }
  
  async handleFormSubmit(e) {
    e.preventDefault();
    
    const formData = {
      full_name: document.getElementById('full_name').value.trim(),
      contact_number: document.getElementById('contact_number').value.trim(),
      department_visiting: document.getElementById('department_visiting').value,
      person_to_visit: document.getElementById('person_to_visit').value.trim(),
      photo: this.photoData.value
    };
    
    try {
      await this.submitVisitorData(formData);
      this.displayBadge(formData);
      this.visitorForm.reset();
    } catch (error) {
      console.error('Submission error:', error);
      this.showError('Failed to register visitor. Please try again.');
    }
  }
  
  async submitVisitorData(formData) {
    const fd = new FormData();
    fd.append('full_name', formData.full_name);
    fd.append('contact_number', formData.contact_number);
    fd.append('department_visiting', formData.department_visiting);
    fd.append('person_to_visit', formData.person_to_visit);
    
    if (formData.photo) {
      const blob = this.dataURLtoBlob(formData.photo);
      fd.append('photo', blob, 'visitor-photo.png');
    }
    
    const response = await fetch('/api/visitors', {
      method: 'POST',
      body: fd
    });
    
    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }
    
    return response.json();
  }
  
  displayBadge(formData) {
    document.getElementById('badge-name').textContent = formData.full_name;
    document.getElementById('badge-contact').textContent = formData.contact_number;
    document.getElementById('badge-department').textContent = formData.department_visiting;
    document.getElementById('badge-host').textContent = formData.person_to_visit;
    document.getElementById('badge-time').textContent = new Date().toLocaleString();
    
    if (formData.photo) {
      document.getElementById('badge-photo').src = formData.photo;
    }
    
    this.visitorBadge.classList.remove('hidden');
  }
  
  printBadge() {
    window.print();
  }
  
  dataURLtoBlob(dataurl) {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    const u8arr = new Uint8Array(bstr.length);
    
    for (let i = 0; i < bstr.length; i++) {
      u8arr[i] = bstr.charCodeAt(i);
    }
    
    return new Blob([u8arr], { type: mime });
  }
  
  showError(message) {
    alert(message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VisitorSystem();
});