import { db } from '$lib/catalog/db';
import type { Volume } from '$lib/types';
import { showSnackbar } from '$lib/util/snackbar';
import { requestPersistentStorage } from '$lib/util/upload';
import { ZipReader, BlobWriter, getMimeType, Uint8ArrayReader } from '@zip.js/zip.js';

export * from './web-import'

const zipTypes = ['zip', 'cbz', 'ZIP', 'CBZ'];
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

export async function unzipManga(file: File) {
  const zipFileReader = new Uint8ArrayReader(new Uint8Array(await file.arrayBuffer()));
  const zipReader = new ZipReader(zipFileReader);

  const entries = await zipReader.getEntries();
  const unzippedFiles: Record<string, File> = {};

  const sortedEntries = entries.sort((a, b) => {
    return a.filename.localeCompare(b.filename, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  })

  for (const entry of sortedEntries) {
    const mime = getMimeType(entry.filename);
    const isMokuroFile = entry.filename.split('.').pop() === 'mokuro'

    if (imageTypes.includes(mime) || isMokuroFile) {
      const blob = await entry.getData?.(new BlobWriter(mime));
      if (blob) {
        const fileName = entry.filename.split('/').pop() || entry.filename;
        const file = new File([blob], fileName, { type: mime });
        if (!file.webkitRelativePath) {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: entry.filename
          })
        }
        unzippedFiles[entry.filename] = file;
      }
    }
  }

  return unzippedFiles;
}

function getDetails(file: File) {
  const { webkitRelativePath, name } = file
  const split = name.split('.');
  const ext = split.pop();
  const filename = split.join('.');
  let path = filename

  if (webkitRelativePath) {
    path = webkitRelativePath.replace(/\.[^./]*$/, "");
  }

  return {
    filename,
    ext,
    path
  };
}

async function getFile(fileEntry: FileSystemFileEntry) {
  try {
    return new Promise<File>((resolve, reject) => fileEntry.file((file) => {
      if (!file.webkitRelativePath) {
        Object.defineProperty(file, 'webkitRelativePath', {
          value: fileEntry.fullPath.substring(1)
        })
      }
      resolve(file)
    }, reject));
  } catch (err) {
    console.log(err);
  }
}

export async function scanFiles(item: FileSystemEntry, files: Promise<File | undefined>[]) {
  if (item.isDirectory) {
    const directoryReader = (item as FileSystemDirectoryEntry).createReader();
    await new Promise<void>((resolve) => {
      function readEntries() {
        directoryReader.readEntries(async (entries) => {
          if (entries.length > 0) {
            for (const entry of entries) {
              if (entry.isFile) {
                files.push(getFile(entry as FileSystemFileEntry));
              } else {
                await scanFiles(entry, files);
              }
            }
            readEntries()
          } else {
            resolve();
          }
        });
      }

      readEntries()
    });
  }
}

export async function processFiles(_files: File[]) {
  const volumes: Record<string, Volume> = {};
  const mangas: string[] = [];

  const files = _files.sort((a, b) => {
    return decodeURI(a.name).localeCompare(decodeURI(b.name), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  })

  for (const file of files) {
    const { ext, filename, path } = getDetails(file);

    if (ext === 'mokuro') {
      const mokuroData: Volume['mokuroData'] = JSON.parse(await file.text());

      if (!mangas.includes(mokuroData.title_uuid)) {
        mangas.push(mokuroData.title_uuid);
      }


      volumes[path] = {
        ...volumes[path],
        mokuroData,
        volumeName: filename
      };
      continue;
    }
  }


  for (const file of files) {
    const { ext, path } = getDetails(file);
    const { type, webkitRelativePath } = file;

    const mimeType = type || getMimeType(file.name);

    if (imageTypes.includes(mimeType)) {
      if (webkitRelativePath) {
        const imageName = webkitRelativePath.split('/').at(-1);
        let vol = ''

        Object.keys(volumes).forEach((key) => {
          if (webkitRelativePath.startsWith(key)) {
            vol = key
          }
        })

        if (vol && imageName) {
          volumes[vol] = {
            ...volumes[vol],
            files: {
              ...volumes[vol]?.files,
              [imageName]: file
            }
          };
        }
      }
      continue;
    }

    if (ext && zipTypes.includes(ext)) {
      const unzippedFiles = await unzipManga(file);

      if (files.length === 1) {
        processFiles(Object.values(unzippedFiles))
        return;
      }

      volumes[path] = {
        ...volumes[path],
        files: unzippedFiles
      };

      continue;
    }
  }

  const vols = Object.values(volumes);

  if (vols.length > 0) {
    const valid = vols.map((vol) => {
      const { files, mokuroData, volumeName } = vol;

      if (!mokuroData || !volumeName) {
        showSnackbar('Missing .mokuro file');
        return false;
      }

      if (!files) {
        showSnackbar('Missing image files');
        return false;
      }

      return true;
    });

    if (!valid.includes(false)) {
      await requestPersistentStorage();

      for (const key of mangas) {
        const existingCatalog = await db.catalog.get(key);

        const filtered = vols.filter((vol) => {
          return (
            !existingCatalog?.manga.some((manga) => {
              return manga.mokuroData.volume_uuid === vol.mokuroData.volume_uuid;
            }) && key === vol.mokuroData.title_uuid
          );
        });

        if (existingCatalog) {
          await db.catalog.update(key, { manga: [...existingCatalog.manga, ...filtered] });
        } else {
          await db.catalog.add({ id: key, manga: filtered });
        }
      }

      showSnackbar('Catalog updated successfully');
    }
  } else {
    showSnackbar('Missing .mokuro file');
  }
}
