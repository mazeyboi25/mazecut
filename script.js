/* ============================================================
   MAZECUT — script.js

   Responsibilities:
   1. Image upload / drag-and-drop
   2. Client-side validation
   3. Processing progress UI
   4. Calling the Python FastAPI endpoint
   5. Before / after comparison
   6. Background preview controls
   7. PNG export
   8. Intro / result animation
   9. Smooth scrolling

   The file is intentionally expanded and commented so it is
   easier to understand and edit in VS Code.
   ============================================================ */

(() => {
  "use strict";


  /* ==========================================================
     01. SMALL DOM HELPERS
     ========================================================== */

  const $ = (selector, scope = document) => {
    return scope.querySelector(selector);
  };


  const $$ = (selector, scope = document) => {
    return [...scope.querySelectorAll(selector)];
  };


  const wait = (milliseconds) => {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  };


  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;


  /* ==========================================================
     02. ELEMENT REFERENCES
     ========================================================== */

  const elements = {
    /* Upload */
    input: $("#image-input"),
    chooseButton: $("#choose-image-button"),
    dropZone: $("#drop-zone"),
    dropTitle: $("#drop-title"),
    dropDescription: $("#drop-description"),

    /* View states */
    uploadState: $("#upload-state"),
    processingState: $("#processing-state"),
    resultWorkspace: $("#result-workspace"),

    /* Processing */
    processingImage: $("#processing-image"),
    processingMessage: $("#processing-message"),
    processingPercent: $("#processing-percent"),
    progressFill: $("#progress-fill"),
    processingSteps: $$(".processing-steps span"),

    /* Result */
    originalImage: $("#original-image"),
    resultImage: $("#result-image"),
    resultLayer: $("#result-layer"),
    resultFileName: $("#result-file-name"),

    /* Comparison */
    comparison: $("#comparison"),
    comparisonRange: $("#comparison-range"),

    /* Output buttons */
    newImageButton: $("#new-image-button"),
    downloadButton: $("#download-button"),
    panelDownloadButton: $("#panel-download-button"),

    /* Background controls */
    backgroundButtons: $$(".bg-option"),
    customColorRow: $("#custom-color-row"),
    backgroundColor: $("#background-color"),
    customColorPreview: $("#custom-color-preview"),

    /* File details */
    transparencyLabel: $("#transparency-label"),
    originalDimensions: $("#original-dimensions"),
    outputDimensions: $("#output-dimensions"),

    /* Feedback */
    toast: $("#toast")
  };


  /* ==========================================================
     03. APP STATE
     ========================================================== */

  const state = {
    file: null,

    originalObjectUrl: "",
    resultObjectUrl: "",

    resultBlob: null,

    selectedBackground: "transparent",

    progress: 0,
    progressTimer: null
  };


  /* ==========================================================
     04. CONSTANTS
     ========================================================== */

  const MAX_FILE_SIZE =
    3.5 *
    1024 *
    1024;


  const SUPPORTED_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];


  /* ==========================================================
     05. TOAST MESSAGE
     ========================================================== */

  function showToast(message) {
    elements.toast.textContent =
      message;

    elements.toast.classList.add(
      "visible"
    );


    window.clearTimeout(
      showToast.timer
    );


    showToast.timer =
      window.setTimeout(() => {
        elements.toast.classList.remove(
          "visible"
        );
      }, 2600);
  }


  /* ==========================================================
     06. SWITCH BETWEEN APP STATES
     ========================================================== */

  function showView(viewName) {
    elements.uploadState.hidden =
      viewName !== "upload";

    elements.processingState.hidden =
      viewName !== "processing";

    elements.resultWorkspace.hidden =
      viewName !== "result";
  }


  /* ==========================================================
     07. PROGRESS UI
     ========================================================== */

  function setProgress(
    percentage,
    message,
    activeStep
  ) {
    const safePercentage =
      Math.max(
        0,
        Math.min(
          100,
          percentage
        )
      );


    state.progress =
      safePercentage;


    elements.progressFill.style.width =
      `${safePercentage}%`;


    elements.processingPercent.textContent =
      `${Math.round(safePercentage)}%`;


    elements.processingMessage.textContent =
      message;


    elements.processingSteps.forEach(
      (stepElement, index) => {
        stepElement.classList.toggle(
          "active",
          index <= activeStep
        );
      }
    );
  }


  function resetProgress() {
    window.clearInterval(
      state.progressTimer
    );


    setProgress(
      8,
      "Uploading image",
      0
    );
  }


  /*
   * The real server request does not provide upload/model progress.
   * This visual progress animation approaches 89%, then waits for
   * the Python response before moving to 96% and 100%.
   */

  function startProgressAnimation() {
    window.clearInterval(
      state.progressTimer
    );


    state.progressTimer =
      window.setInterval(() => {

        if (state.progress >= 89) {
          window.clearInterval(
            state.progressTimer
          );

          return;
        }


        let increase = 1.3;


        if (state.progress < 30) {
          increase =
            Math.random() * 6;
        }
        else if (state.progress < 62) {
          increase =
            Math.random() * 3.6;
        }
        else {
          increase =
            Math.random() * 1.5;
        }


        const nextProgress =
          Math.min(
            89,
            state.progress + increase
          );


        let message =
          "Uploading image";

        let step =
          0;


        if (nextProgress >= 24) {
          message =
            "Detecting foreground subject";

          step =
            1;
        }


        if (nextProgress >= 58) {
          message =
            "Creating transparency mask";

          step =
            2;
        }


        if (nextProgress >= 78) {
          message =
            "Preparing PNG output";

          step =
            3;
        }


        setProgress(
          nextProgress,
          message,
          step
        );

      }, 240);
  }


  /* ==========================================================
     08. OBJECT URL MANAGEMENT
     ========================================================== */

  function clearObjectUrls() {
    if (state.originalObjectUrl) {
      URL.revokeObjectURL(
        state.originalObjectUrl
      );
    }


    if (state.resultObjectUrl) {
      URL.revokeObjectURL(
        state.resultObjectUrl
      );
    }


    state.originalObjectUrl =
      "";

    state.resultObjectUrl =
      "";

    state.resultBlob =
      null;
  }


  /* ==========================================================
     09. IMAGE DIMENSIONS
     ========================================================== */

  function getImageDimensions(url) {
    return new Promise(
      (resolve, reject) => {

        const image =
          new Image();


        image.onload = () => {
          resolve({
            width: image.naturalWidth,
            height: image.naturalHeight
          });
        };


        image.onerror =
          reject;


        image.src =
          url;
      }
    );
  }


  /* ==========================================================
     10. FILE VALIDATION
     ========================================================== */

  function validateFile(file) {
    if (!file) {
      return {
        valid: false,
        message: ""
      };
    }


    if (
      !SUPPORTED_TYPES.includes(
        file.type
      )
    ) {
      return {
        valid: false,
        message:
          "Choose a JPG, PNG, or WEBP image."
      };
    }


    if (
      file.size >
      MAX_FILE_SIZE
    ) {
      return {
        valid: false,
        message:
          "This image is larger than the 3.5 MB limit."
      };
    }


    return {
      valid: true,
      message: ""
    };
  }


  /* ==========================================================
     11. MAIN IMAGE PROCESSING FLOW
     ========================================================== */

  async function processFile(file) {
    const validation =
      validateFile(file);


    if (!validation.valid) {
      if (validation.message) {
        showToast(
          validation.message
        );
      }

      return;
    }


    /*
     * Remove object URLs from a previous run before
     * creating new ones.
     */

    clearObjectUrls();


    elements.dropZone.classList.remove(
      "has-error"
    );


    state.file =
      file;


    state.originalObjectUrl =
      URL.createObjectURL(file);


    /*
     * Use the local object URL immediately so the user
     * sees the source image while the Python backend works.
     */

    elements.processingImage.src =
      state.originalObjectUrl;

    elements.originalImage.src =
      state.originalObjectUrl;

    elements.resultFileName.textContent =
      file.name;


    /*
     * Read original dimensions for the information panel.
     */

    try {
      const dimensions =
        await getImageDimensions(
          state.originalObjectUrl
        );


      elements.originalDimensions.textContent =
        `${dimensions.width}×${dimensions.height}`;
    }
    catch {
      elements.originalDimensions.textContent =
        "—";
    }


    /*
     * Enter processing state.
     */

    showView(
      "processing"
    );


    resetProgress();

    startProgressAnimation();


    document
      .querySelector("#studio")
      ?.scrollIntoView({
        behavior:
          prefersReducedMotion
            ? "auto"
            : "smooth",

        block:
          "start"
      });


    /*
     * Prepare multipart/form-data for FastAPI.
     */

    const formData =
      new FormData();


    formData.append(
      "image",
      file
    );


    try {
      const response =
        await fetch(
          "/api",
          {
            method: "POST",
            body: formData
          }
        );


      /*
       * Try to retrieve a useful error message from FastAPI.
       */

      if (!response.ok) {
        let message =
          "Background removal failed.";


        try {
          const data =
            await response.json();


          if (data?.detail) {
            message =
              data.detail;
          }
        }
        catch {
          /* Ignore JSON parsing failure. */
        }


        throw new Error(
          message
        );
      }


      /*
       * Python finished processing.
       */

      window.clearInterval(
        state.progressTimer
      );


      setProgress(
        96,
        "Finalizing output",
        3
      );


      const resultBlob =
        await response.blob();


      if (
        !resultBlob.type.includes(
          "image"
        )
      ) {
        throw new Error(
          "The server returned an invalid image."
        );
      }


      state.resultBlob =
        resultBlob;


      state.resultObjectUrl =
        URL.createObjectURL(
          resultBlob
        );


      elements.resultImage.src =
        state.resultObjectUrl;


      /*
       * Read processed image dimensions.
       */

      try {
        const dimensions =
          await getImageDimensions(
            state.resultObjectUrl
          );


        elements.outputDimensions.textContent =
          `${dimensions.width}×${dimensions.height}`;
      }
      catch {
        elements.outputDimensions.textContent =
          elements.originalDimensions.textContent;
      }


      setProgress(
        100,
        "Background removed",
        3
      );


      await wait(
        420
      );


      showView(
        "result"
      );


      resetComparison();

      setBackground(
        "transparent"
      );


      animateResultEntrance();


      showToast(
        "Background removed."
      );
    }
    catch (error) {
      window.clearInterval(
        state.progressTimer
      );


      console.error(
        error
      );


      showView(
        "upload"
      );


      elements.dropZone.classList.add(
        "has-error"
      );


      elements.dropTitle.textContent =
        "Try another image.";


      elements.dropDescription.textContent =
        error.message ||
        "The image could not be processed.";


      showToast(
        error.message ||
        "Background removal failed."
      );
    }
  }


  /* ==========================================================
     12. BEFORE / AFTER COMPARISON
     ========================================================== */

  function setComparison(
    value
  ) {
    const safeValue =
      Math.max(
        0,
        Math.min(
          100,
          Number(value)
        )
      );


    elements.comparison.style.setProperty(
      "--split",
      `${safeValue}%`
    );
  }


  function resetComparison() {
    elements.comparisonRange.value =
      "50";


    setComparison(
      50
    );
  }


  /* ==========================================================
     13. BACKGROUND PREVIEW
     ========================================================== */

  function setBackground(
    backgroundType
  ) {
    state.selectedBackground =
      backgroundType;


    /*
     * Update selected button.
     */

    elements.backgroundButtons.forEach(
      (button) => {

        button.classList.toggle(
          "active",
          button.dataset.background ===
            backgroundType
        );

      }
    );


    /*
     * Only show color picker when custom mode is selected.
     */

    elements.customColorRow.hidden =
      backgroundType !== "custom";


    /*
     * Transparent background uses the checkerboard class.
     */

    if (
      backgroundType ===
      "transparent"
    ) {
      elements.resultLayer.classList.add(
        "checkerboard"
      );


      elements.resultLayer.style.background =
        "";


      elements.transparencyLabel.textContent =
        "YES";


      return;
    }


    /*
     * Solid background modes.
     */

    elements.resultLayer.classList.remove(
      "checkerboard"
    );


    let color =
      "#ffffff";


    if (
      backgroundType ===
      "black"
    ) {
      color =
        "#111111";
    }


    if (
      backgroundType ===
      "custom"
    ) {
      color =
        elements.backgroundColor.value;
    }


    elements.resultLayer.style.background =
      color;


    elements.transparencyLabel.textContent =
      "NO";
  }


  /* ==========================================================
     14. BUILD DOWNLOAD FILE
     ========================================================== */

  async function createDownloadBlob() {
    /*
     * No extra compositing is required when the user wants
     * a transparent PNG.
     */

    if (
      state.selectedBackground ===
      "transparent"
    ) {
      return state.resultBlob;
    }


    /*
     * For solid backgrounds, draw the transparent cutout
     * over a canvas before export.
     */

    const image =
      new Image();


    image.src =
      state.resultObjectUrl;


    await image.decode();


    const canvas =
      document.createElement(
        "canvas"
      );


    canvas.width =
      image.naturalWidth;

    canvas.height =
      image.naturalHeight;


    const context =
      canvas.getContext(
        "2d"
      );


    let backgroundColor =
      "#ffffff";


    if (
      state.selectedBackground ===
      "black"
    ) {
      backgroundColor =
        "#111111";
    }


    if (
      state.selectedBackground ===
      "custom"
    ) {
      backgroundColor =
        elements.backgroundColor.value;
    }


    context.fillStyle =
      backgroundColor;


    context.fillRect(
      0,
      0,
      canvas.width,
      canvas.height
    );


    context.drawImage(
      image,
      0,
      0,
      canvas.width,
      canvas.height
    );


    return new Promise(
      (resolve, reject) => {

        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            }
            else {
              reject(
                new Error(
                  "Could not create PNG output."
                )
              );
            }
          },
          "image/png",
          1
        );

      }
    );
  }


  /* ==========================================================
     15. DOWNLOAD RESULT
     ========================================================== */

  async function downloadResult() {
    if (!state.resultBlob) {
      return;
    }


    try {
      const blob =
        await createDownloadBlob();


      const downloadUrl =
        URL.createObjectURL(
          blob
        );


      const link =
        document.createElement(
          "a"
        );


      const originalName =
        state.file?.name ||
        "image";


      const baseName =
        originalName.replace(
          /\.(jpe?g|png|webp)$/i,
          ""
        );


      link.href =
        downloadUrl;


      link.download =
        `${baseName}-mazecut.png`;


      document.body.appendChild(
        link
      );


      link.click();

      link.remove();


      URL.revokeObjectURL(
        downloadUrl
      );


      showToast(
        "PNG saved."
      );
    }
    catch (error) {
      console.error(
        error
      );


      showToast(
        "Could not create the PNG."
      );
    }
  }


  /* ==========================================================
     16. RESET STUDIO
     ========================================================== */

  function resetStudio() {
    window.clearInterval(
      state.progressTimer
    );


    clearObjectUrls();


    state.file =
      null;

    state.progress =
      0;

    state.selectedBackground =
      "transparent";


    elements.input.value =
      "";


    elements.processingImage.removeAttribute(
      "src"
    );


    elements.originalImage.removeAttribute(
      "src"
    );


    elements.resultImage.removeAttribute(
      "src"
    );


    elements.dropZone.classList.remove(
      "has-error"
    );


    elements.dropTitle.textContent =
      "Drop your image here.";


    elements.dropDescription.textContent =
      "Or choose a photo from your device.";


    elements.originalDimensions.textContent =
      "—";


    elements.outputDimensions.textContent =
      "—";


    showView(
      "upload"
    );


    document
      .querySelector("#studio")
      ?.scrollIntoView({
        behavior:
          prefersReducedMotion
            ? "auto"
            : "smooth",

        block:
          "start"
      });
  }


  /* ==========================================================
     17. RESULT ENTRANCE ANIMATION
     ========================================================== */

  function animateResultEntrance() {
    if (
      !window.anime ||
      prefersReducedMotion
    ) {
      return;
    }


    window.anime({
      targets: [
        ".result-topbar",
        ".compare-card",
        ".output-panel"
      ],

      translateY: [
        18,
        0
      ],

      opacity: [
        0,
        1
      ],

      delay:
        window.anime.stagger(
          70
        ),

      duration:
        650,

      easing:
        "easeOutExpo"
    });
  }


  /* ==========================================================
     18. HERO INTRO ANIMATION
     ========================================================== */

  function animateIntro() {
    if (
      !window.anime ||
      prefersReducedMotion
    ) {
      return;
    }


    window.anime
      .timeline({
        easing:
          "easeOutExpo"
      })

      .add({
        targets:
          ".topbar",

        translateY: [
          -15,
          0
        ],

        opacity: [
          0,
          1
        ],

        duration:
          650
      })

      .add(
        {
          targets:
            ".hero__copy h1 span",

          translateY: [
            35,
            0
          ],

          opacity: [
            0,
            1
          ],

          delay:
            window.anime.stagger(
              70
            ),

          duration:
            820
        },
        "-=360"
      )

      .add(
        {
          targets: [
            ".hero__lede",
            ".hero__cta"
          ],

          translateY: [
            16,
            0
          ],

          opacity: [
            0,
            1
          ],

          delay:
            window.anime.stagger(
              80
            ),

          duration:
            620
        },
        "-=550"
      )

      .add(
        {
          targets:
            ".photo-card",

          scale: [
            0.94,
            1
          ],

          opacity: [
            0,
            1
          ],

          delay:
            window.anime.stagger(
              100
            ),

          duration:
            850
        },
        "-=650"
      );


    /*
     * Slow ambient rotation for the decorative circles.
     */

    window.anime({
      targets:
        ".orbit--one",

      rotate:
        360,

      duration:
        42000,

      loop:
        true,

      easing:
        "linear"
    });


    window.anime({
      targets:
        ".orbit--two",

      rotate:
        -360,

      duration:
        34000,

      loop:
        true,

      easing:
        "linear"
    });
  }


  /* ==========================================================
     19. LENIS SMOOTH SCROLL
     ========================================================== */

  function initializeLenis() {
    if (
      !window.Lenis ||
      prefersReducedMotion
    ) {
      return;
    }


    const lenis =
      new window.Lenis({
        duration:
          0.90,

        smoothWheel:
          true,

        smoothTouch:
          false
      });


    const frame = (time) => {
      lenis.raf(
        time
      );


      window.requestAnimationFrame(
        frame
      );
    };


    window.requestAnimationFrame(
      frame
    );
  }


  /* ==========================================================
     20. EVENT BINDING
     ========================================================== */

  function bindEvents() {
    /* Open file picker */

    elements.chooseButton.addEventListener(
      "click",
      () => {
        elements.input.click();
      }
    );


    /* File picker changed */

    elements.input.addEventListener(
      "change",
      () => {
        processFile(
          elements.input.files[0]
        );
      }
    );


    /* -----------------------------------------
       Drag and drop
       ----------------------------------------- */

    [
      "dragenter",
      "dragover"
    ].forEach((eventName) => {

      elements.dropZone.addEventListener(
        eventName,
        (event) => {
          event.preventDefault();


          elements.dropZone.classList.add(
            "is-dragging"
          );


          elements.dropTitle.textContent =
            "Release to cut.";


          elements.dropDescription.textContent =
            "MazeCut is ready for this image.";
        }
      );

    });


    [
      "dragleave",
      "drop"
    ].forEach((eventName) => {

      elements.dropZone.addEventListener(
        eventName,
        (event) => {
          event.preventDefault();


          elements.dropZone.classList.remove(
            "is-dragging"
          );


          if (
            eventName ===
            "drop"
          ) {
            processFile(
              event.dataTransfer.files[0]
            );

            return;
          }


          elements.dropTitle.textContent =
            "Drop your image here.";


          elements.dropDescription.textContent =
            "Or choose a photo from your device.";
        }
      );

    });


    /* -----------------------------------------
       Comparison slider
       ----------------------------------------- */

    elements.comparisonRange.addEventListener(
      "input",
      () => {
        setComparison(
          elements.comparisonRange.value
        );
      }
    );


    /* -----------------------------------------
       Background buttons
       ----------------------------------------- */

    elements.backgroundButtons.forEach(
      (button) => {

        button.addEventListener(
          "click",
          () => {
            setBackground(
              button.dataset.background
            );
          }
        );

      }
    );


    /* -----------------------------------------
       Custom color
       ----------------------------------------- */

    elements.backgroundColor.addEventListener(
      "input",
      () => {

        elements.customColorPreview.style.background =
          elements.backgroundColor.value;


        if (
          state.selectedBackground ===
          "custom"
        ) {
          setBackground(
            "custom"
          );
        }

      }
    );


    /* -----------------------------------------
       Download buttons
       ----------------------------------------- */

    elements.downloadButton.addEventListener(
      "click",
      downloadResult
    );


    elements.panelDownloadButton.addEventListener(
      "click",
      downloadResult
    );


    /* -----------------------------------------
       Reset
       ----------------------------------------- */

    elements.newImageButton.addEventListener(
      "click",
      resetStudio
    );


    /* -----------------------------------------
       Clean object URLs before page exits
       ----------------------------------------- */

    window.addEventListener(
      "beforeunload",
      clearObjectUrls
    );
  }


  /* ==========================================================
     21. INITIALIZE
     ========================================================== */

  function initialize() {
    bindEvents();

    initializeLenis();

    animateIntro();
  }


  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      {
        once: true
      }
    );
  }
  else {
    initialize();
  }

})();
