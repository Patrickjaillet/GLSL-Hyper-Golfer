float sign2(float x) {
    float s;
    if (x >= 0.0) {
        s = 1.0;
    } else {
        s = -1.0;
    }
    return s;
}

vec3 pick(vec3 a, vec3 b, float t) {
    vec3 result;
    if (t > 0.5)
        result = a;
    else
        result = b;
    return result;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float m = sign2(uv.x - 0.5);
    vec3 col = pick(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), uv.y);
    fragColor = vec4(col * m, 1.0);
}
