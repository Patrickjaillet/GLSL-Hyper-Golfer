float sumTo(float n) {
    float total = 0.0;
    for (int i = 0; i < 10; i = i + 1) {
        total = total + n;
    }
    return total;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float x = 0.0;
    x = x + 1.0;
    x -= 1.0;
    x += 2.0;
    float y = (x += 1.0);
    fragColor = vec4(x, y, sumTo(3.0), 1.0);
}
