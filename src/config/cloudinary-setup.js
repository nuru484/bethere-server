// src/config/cloudinary-setup.js
//
// Configures the Cloudinary SDK exactly once, as an import side effect.
//
// Owning it here, rather than in app.js, means any consumer of
// utils/cloudinary.js is configured by virtue of importing it, in either
// entrypoint. app.js is imported only by the WEB process, so the worker
// (worker.js -> lifecycle.js -> retention -> evidence purge -> deleteImage)
// would otherwise run with an unconfigured SDK and every destroy would throw
// "Must supply api_key".
import { v2 as cloudinary } from "cloudinary";
import ENV from "./env.js";

cloudinary.config({
  cloud_name: ENV.CLOUDINARY_CLOUD_NAME,
  api_key: ENV.CLOUDINARY_API_KEY,
  api_secret: ENV.CLOUDINARY_API_SECRET,
});

export default cloudinary;
