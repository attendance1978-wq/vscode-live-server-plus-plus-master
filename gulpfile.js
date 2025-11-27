const { src, dest, series } = require('gulp');
const ts = require('gulp-typescript');
const tsProject = ts.createProject('tsconfig.json');

// Compile TypeScript
function buildTS() {
    return tsProject.src()
        .pipe(tsProject())
        .js.pipe(dest('out'));
}

// Default task
exports.default = series(buildTS);
