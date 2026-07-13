float fAtan(float x) {
    return (9.8696044 * x) / (4.0 + sqrt(34.0 + 39.4784176 * x * x));
}

float fAtan2(float y, float x) {
    float ax = abs(x);
    float ay = abs(y);
    if (ax > ay) {
        float a = fAtan(y / x);
        return x < 0.0 ? (y < 0.0 ? a - 3.14159265 : a + 3.14159265) : a;
    } else {
        float a = fAtan(x / y);
        return y < 0.0 ? -1.57079632 - a : 1.57079632 - a;
    }
}

vec3 getNormal(vec3 p, float t) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
        fAtan2(p.z, p.x) - e.xyy.x,
        fAtan2(p.z, p.y) - e.yxy.x,
        fAtan2(p.y, p.x) - e.yyx.x
    ));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec3 p = vec3(fragCoord, 1.0);
    vec3 n = getNormal(p, 0.0);
    fragColor = vec4(n, 1.0);
}
