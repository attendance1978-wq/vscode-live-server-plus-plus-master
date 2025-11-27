const { src, dest, series } = require('gulp');
const ts = require('gulp-typescript');
const tsProject = ts.createProject('tsconfig.json');

function buildTS() {
    return tsProject.src()
        .pipe(tsProject())
        .js.pipe(dest('out'));
}

exports.default = series(buildTS);
