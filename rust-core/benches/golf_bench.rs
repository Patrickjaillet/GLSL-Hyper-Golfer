// Perf benchmarks for the golfing engine, tracked over time via `cargo
// bench` to catch regressions on larger shaders -- unit/parity tests only
// check correctness, never how long a golf pass takes.
//
// `fractal.glsl` is the biggest real fixture (~1.1 KB) but real Shadertoy
// shaders routinely run several times that size, so `synthetic_large` is
// generated here (many small functions with dead locals/stores, the shape
// every aggressive pass has to scan) to see how the engine scales past what
// the fixture corpus alone would show.
use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use glsl_golf_core::{golf_with_options, AggressiveOptions};

const FRACTAL: &str = include_str!("../../fixtures/fractal.glsl");
const SWIZZLE: &str = include_str!("../../fixtures/swizzle_after_dot.glsl");

fn synthetic_large(functions: usize) -> String {
    let mut src = String::new();
    for i in 0..functions {
        src.push_str(&format!(
            "float helper{i}(float x) {{\n\
             \tfloat unused{i} = x * 2.0;\n\
             \tfloat a{i} = x + 1.0;\n\
             \ta{i} = a{i} * 3.0;\n\
             \tvec3 v{i} = vec3(1.0, 1.0, 1.0);\n\
             \treturn a{i} + v{i}.x;\n\
             }}\n"
        ));
    }
    src.push_str("void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n\tfloat total = 0.0;\n");
    for i in 0..functions {
        src.push_str(&format!("\ttotal += helper{i}(fragCoord.x);\n"));
    }
    src.push_str("\tfragColor = vec4(total, total, total, 1.0);\n}\n");
    src
}

fn bench_fixtures(c: &mut Criterion) {
    let mut group = c.benchmark_group("fixtures");
    for (name, src) in [("fractal", FRACTAL), ("swizzle_after_dot", SWIZZLE)] {
        group.bench_with_input(BenchmarkId::new("safe", name), src, |b, src| {
            b.iter(|| golf_with_options(black_box(src), AggressiveOptions::none()));
        });
        group.bench_with_input(BenchmarkId::new("aggressive", name), src, |b, src| {
            b.iter(|| golf_with_options(black_box(src), AggressiveOptions::all()));
        });
    }
    group.finish();
}

fn bench_scaling(c: &mut Criterion) {
    let mut group = c.benchmark_group("synthetic_scaling");
    for functions in [10, 50, 200] {
        let src = synthetic_large(functions);
        group.bench_with_input(
            BenchmarkId::new("aggressive", functions),
            &src,
            |b, src| {
                b.iter(|| golf_with_options(black_box(src), AggressiveOptions::all()));
            },
        );
    }
    group.finish();
}

criterion_group!(benches, bench_fixtures, bench_scaling);
criterion_main!(benches);
