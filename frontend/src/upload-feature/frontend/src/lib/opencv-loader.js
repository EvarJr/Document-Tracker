// Loads OpenCV.js once and caches the promise, so multiple components
// calling this simultaneously don't inject the script twice.
let loadingPromise = null;

export function loadOpenCv() {
  if (typeof window.cv !== 'undefined' && window.cv.Mat) {
    return Promise.resolve(window.cv);
  }

  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.9.0/opencv.js';
    script.async = true;

    script.onload = () => {
      // opencv.js finishes downloading the JS wrapper first, then compiles
      // its WASM runtime async. cv.Mat only exists once that's done.
      if (window.cv && window.cv.Mat) {
        resolve(window.cv);
      } else {
        window.cv['onRuntimeInitialized'] = () => resolve(window.cv);
      }
    };

    script.onerror = () => reject(new Error('Failed to load OpenCV.js — check your connection.'));

    document.body.appendChild(script);
  });

  return loadingPromise;
}
