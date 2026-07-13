void applyEffect(inout vec3 color, float amount) {
    if (amount <= 0.0) {
        return;
    }
    color *= 1.0 + amount;
    return;
}

float safeDivide(float a, float b) {
    if (b == 0.0) return 0.0;
    return a / b;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = vec3(uv, 0.5);
    applyEffect(col, 0.2);
    fragColor = vec4(col, safeDivide(1.0, 2.0));
    return;
}
