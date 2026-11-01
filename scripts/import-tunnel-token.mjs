// Local credential handoff utility. Never prints secret bytes, hashes, or native errors.
// Call with source and destination paths only; no credential values in arguments.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const source = process.argv[2];
const destination = process.argv[3];
let sourceFd, temporaryFd, verifyFd, temporary;
let imported = false, deleted = false, bytes;
function fail() { throw new Error('Credential import check failed'); }
function checkParents(file) {
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent) fail();
  let current = path.parse(parent).root;
  for (const component of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) fail();
  }
  const st = fs.lstatSync(parent);
  if (st.uid !== process.geteuid() || (st.mode & 0o077) !== 0) fail();
}
function checkFile(st) {
  if (!st.isFile() || st.nlink !== 1 || st.uid !== process.geteuid() || (st.mode & 0o077) !== 0 || st.size < 1 || st.size > 16384) fail();
}
function protectedDirectory(directory) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') fail(); }
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.geteuid() || (st.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) fail();
}
try {
  if (process.platform === 'win32' || !source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)
      || path.resolve(source) !== source || path.resolve(destination) !== destination || source === destination) fail();
  checkParents(source);
  const sourceLink = fs.lstatSync(source);
  if (sourceLink.isSymbolicLink()) fail();
  sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const original = fs.fstatSync(sourceFd);
  checkFile(original);
  if (original.ino !== sourceLink.ino || original.dev !== sourceLink.dev) fail();
  bytes = fs.readFileSync(sourceFd);
  if (bytes.length !== original.size) fail();

  const secretDir = path.dirname(destination);
  const storage = path.dirname(secretDir);
  // The project .pi directory must already exist and must not be symlinked.
  if (fs.realpathSync(path.dirname(storage)) !== path.dirname(storage)) fail();
  protectedDirectory(storage);
  protectedDirectory(secretDir);
  checkParents(destination);
  const ignore = path.join(secretDir, '.gitignore');
  try { fs.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') fail();
    const st = fs.lstatSync(ignore);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || fs.readFileSync(ignore, 'utf8') !== '*\n') fail();
  }
  // Never overwrite an existing destination or follow links. Re-running after an
  // uncertain outcome verifies an existing private identical file instead.
  let exists = false;
  try { const st = fs.lstatSync(destination); if (st.isSymbolicLink()) fail(); checkFile(st); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) {
    temporary = path.join(secretDir, `.import-${randomUUID()}.tmp`);
    temporaryFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(temporaryFd, bytes); fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd); temporaryFd = undefined;
    checkParents(destination);
    // Exclusive publication: hard-link refuses to replace an intervening file.
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary); temporary = undefined;
  }
  verifyFd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const verifiedStat = fs.fstatSync(verifyFd); checkFile(verifiedStat);
  const copied = fs.readFileSync(verifyFd);
  const matches = copied.length === bytes.length && timingSafeEqual(copied, bytes);
  copied.fill(0);
  if (!matches) fail();
  fs.fsyncSync(verifyFd);
  const dirFd = fs.openSync(secretDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  imported = true;

  // Delete only the same unchanged handoff inode after verified durable import.
  checkParents(source); checkParents(destination);
  const stillSource = fs.lstatSync(source), stillDestination = fs.lstatSync(destination);
  if (stillSource.isSymbolicLink() || stillSource.dev !== original.dev || stillSource.ino !== original.ino
      || stillSource.size !== original.size || stillSource.mtimeMs !== original.mtimeMs
      || stillDestination.isSymbolicLink() || stillDestination.dev !== verifiedStat.dev || stillDestination.ino !== verifiedStat.ino) fail();
  fs.unlinkSync(source);
  deleted = true;
  const sourceDirFd = fs.openSync(path.dirname(source), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(sourceDirFd); } finally { fs.closeSync(sourceDirFd); }
  process.stdout.write(JSON.stringify({ imported: true, verified: true, handoffDeleted: true, destination }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ imported, handoffDeleted: deleted, error: 'Protected credential handoff failed; inspect nonsecret file metadata before retrying.' }) + '\n');
  process.exitCode = 1;
} finally {
  bytes?.fill(0);
  for (const fd of [sourceFd, temporaryFd, verifyFd]) if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  if (temporary) try { fs.unlinkSync(temporary); } catch {}
}
