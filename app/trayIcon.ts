import { nativeImage, type NativeImage } from 'electron';

// Menu-bar glyph: the logo's thread "l" as a single strand, rendered from
// assets/icon.svg's path at 18pt (1x + 2x). A template image, so macOS tints it
// for light and dark menu bars; the three colored strands don't survive 18px.
const PNG_1X = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAABmJLR0QA/wD/AP+gvaeTAAABP0lEQVQ4jZ3Uvy+dURzH8Zf6USwSNibpVhGtiSZi4g+oQZoaJGZGDRExsXfvKBLRwYII6WQ3XJEiBqSTxaZ+9Bp8b+7JzX0uT09y8v3xfM77+Z5znu9D7dGE77jCKjpf0Fcd9dhDMZnnaMsLmkgAp7gL/1te0M9YuB/xWsRb1cRvaoD6wv4Kexm2PQ+oAd3hH4ftCHuTB1SXPPsbdqAC/CpQsQLah/cRb2esyayodEtfsBH+H8/bzlXRdfgflT/EZTzkqQgOA7iCERTQmCWudf2lQ+0N6Ffc562mFbPK5/JfYxTzGFJukcEMbRum8S5NduEH/uEEY7gI0AGaKyD9OJO0TQ/WcZtUUMAHjCe531jEHDbxGPl7TMJOIr7BAlqSNy9FlcUq8wrDJeFn7GJGRkPik+cf2wmOYitTeFsSPAECw1Uhtf4jXgAAAABJRU5ErkJggg==';
const PNG_2X = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAABmJLR0QA/wD/AP+gvaeTAAACyElEQVRYhb3YT4jVVRQH8E++0WEmNMUwTNRMcGCE/jCEtbCW6aKVUtDC2cjAbGph20jFcBG0sgiiAjdNKRXRKghBCQQXCjYFA+lIjZYVhdHEPJ15Lu7v6W/u787782N+78Dl3XPOvd/z5dx/5/dqlke24228hJW4ivllwu5KNuJbNKJ2A+O9JvNEFjgmk2+He0VmAD+2IdNsu3tB6K0OyTTwfdVkVmImEfgEXkn4FrCpSkJ7EmS+zvlfT/gPdAq+ogSh5xO293L9Mwn/Y52ClyH0XKTP4WxOn0nM2VAloW2RPon/c3otMed2VYRqihv0WqSvS8y7VRWh1eiLbL9H+nBi3o2qCA0kbLOR/nRizKVOA3RLaFXCVo/0FyN9HperIjSXsPXn+tvxTOQ/j/+qIhQvDwzm+uN4IPJ/1WWMrqQmLEH+Fp7IfJuETOR9t/FolYTgjyjod5n9E8UnYyIFsNwSlx2XMaKYuTp2dAte5qa+GekbhM08jos5+weYKoHftXxucSbuuP9cfJTZbuGRMuDLkaGaUFvDlez3kOINXhmhnxO2oex3Ssjgh2XIlJW9iqfptcy3BWt6SQY2Jwj15Hi3kmmLCV1XbvkL0inIIN51/1k4F/k3Spe2lcgIfhIy0ax19iku26clsHcLpclveEebBD0ofHnWc0GPZr5+/BURWsCuLsiMCtVDHuPV1MA+jAn7Is7CTeFYn8D7Cf8v2NqGyHqcTMxt4Fh+4A4cx69LDG62L/Ew1io+tA38jTcUb+oh4R+Sf5bAvYNnCek/JaS8FZF/cTAKMtpi/ILwATCJP9tgz2J/E3SszeAGvhEe0JQc6WB+qzYt2nutAM/jhSWI5OVNxQ3ars3jYzwUgw1bXOnN4bTwRMTlaCsZFoq1dkTq+AJPpkCaAXfiZeEUfSaseVl5XNgPT2X9PqGU/QEXhBo7rhjuyV3fKzY6FaOX1QAAAABJRU5ErkJggg==';

export function trayIcon(): NativeImage {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: Buffer.from(PNG_1X, 'base64') });
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(PNG_2X, 'base64') });
  img.setTemplateImage(true);
  return img;
}
