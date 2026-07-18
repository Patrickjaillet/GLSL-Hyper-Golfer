float square(float a)
{
    return a * a;
}

float addOne(float a)
{
    return a + 1.0;
}

float one()
{
    return 1.0;
}

float first(float a, float b)
{
    return a;
}

float calledTwice(float a)
{
    return a * a;
}

float notBareArg(float a)
{
    return a * a;
}

float withInout(inout float a)
{
    return a * a;
}

float multiStatement(float a)
{
    float b = a * a;
    return b;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float x = fragCoord.x;
    float y = fragCoord.y;

    float r1 = square(x);
    float r2 = 2.0 * addOne(x);
    float r3 = one();
    float r4 = first(x, y);
    float r5 = calledTwice(x) + calledTwice(y);
    float r6 = notBareArg(x + 1.0);
    float r7 = x;
    float r8 = withInout(r7);
    float r9 = multiStatement(x);

    fragColor = vec4(r1, r2 + r3 + r4, r5 + r6 + r8, r9);
}
