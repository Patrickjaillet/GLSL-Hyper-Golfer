float unused(float x)
{
    return x * 2.0;
}

float deadA()
{
    return deadB();
}

float deadB()
{
    return 1.0;
}

float helper(float x)
{
    return x * 2.0;
}

float a(float x)
{
    return b(x);
}

float b(float x)
{
    return x + 1.0;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    fragColor = vec4(helper(1.0) + a(2.0));
}
