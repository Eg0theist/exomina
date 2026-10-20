/** Keep portraits beside the reading surface, without stretching the source image. */
export function cyberpunkFrame({ width, height, aspect = 16 / 9, readingRight = 0, frame }) {
  let imageWidth, imageHeight, left, top, fadeStart = 0, fadeMiddle = 22, fadeEnd = 76;
  const available = Math.max(0, width - readingRight - 32);
  if (frame.kind === 'character' && available >= 100) {
    imageHeight = Math.min(height, available / ((frame.face[2] - frame.face[0]) * aspect));
    imageWidth = imageHeight * aspect;
    top = (height - imageHeight) * .35;
    const minimum = readingRight + 16 + (frame.focus[0] - frame.face[0]) * imageWidth;
    const maximum = width - 16 - (frame.face[2] - frame.focus[0]) * imageWidth;
    const anchor = Math.max(minimum, Math.min(width * .84, maximum));
    left = anchor - frame.focus[0] * imageWidth;
    fadeStart = Math.max(0, left + imageWidth * .06) / width * 100;
    fadeMiddle = Math.max(8, (left + imageWidth * .23) / width * 100);
    fadeEnd = Math.max(fadeMiddle + 12, (left + imageWidth * .44) / width * 100);
  } else {
    imageWidth = Math.max(width, height * aspect);
    imageHeight = imageWidth / aspect;
    left = (width - imageWidth) * frame.focus[0];
    top = (height - imageHeight) * frame.focus[1];
  }
  return {
    imageWidth, imageHeight, left, top, fadeStart, fadeMiddle, fadeEnd,
    topStart: Math.max(0, top - .5) / height * 100,
    topEnd: Math.max(0, top + Math.min(18, imageHeight * .025)) / height * 100,
    bottomStart: Math.min(100, (top + imageHeight - Math.min(45, imageHeight * .08)) / height * 100),
    bottomEnd: Math.min(100, (top + imageHeight + .5) / height * 100),
  };
}
