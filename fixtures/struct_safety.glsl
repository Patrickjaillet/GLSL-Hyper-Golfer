struct Foo
{
    float x;
    float y;
};

struct W
{
    float v;
};

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    Foo f;
    f.x = 1.0;
    f.y = 2.0;

    W a;
    a.v = 3.0;

    vec3 p = vec3(1.0, 2.0, 3.0);
    vec3 q = p.xyz + p.x;

    float longName = 1.0;
    longName = longName + 1.0;

    fragColor = vec4(q, f.x + f.y + a.v + longName);
}
