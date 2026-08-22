import multer from "multer";
import { BadRequestError } from "../middleware/error-handler.js";
import { LIVENESS } from "./constants.js";

const storage = multer.memoryStorage();

// File filter for images only
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/jpg",
    "image/webp",
    "image/heic",
    "image/heif",
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new BadRequestError(
        "Only image files (JPEG, PNG, JPG, WEBP, HEIC) are allowed."
      ),
      false
    );
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max file size
  },
});

// Check-in/out frame bursts: client-compressed JPEGs are tiny, so a tight
// per-frame cap plus a hard file count keeps a check-in from buffering tens of
// MB in memory (16 frames x 5MB would otherwise be the ceiling).
export const frameUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1.5 * 1024 * 1024, // 1.5MB per frame
    // Busboy's global file cap. Sized to the LARGEST per-route allowance:
    // batch routes pass .array("frames", MAX_FRAMES) and step routes
    // .array("frames", MAX_STEP_FRAMES), and the per-route maxCount is what
    // enforces the tighter bound. Using MAX_FRAMES alone here silently
    // rejects legal 17-20 frame step bursts with UPLOAD_ERROR before the
    // route-level count check ever runs.
    files: Math.max(LIVENESS.MAX_FRAMES, LIVENESS.MAX_STEP_FRAMES),
  },
});
